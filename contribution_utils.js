import { listReposQuery, privateReposQuery, repoDetailsQuery } from './queries/index.js';
import {
    createGithubClient,
    createMonthlyRanges,
    dateStamp,
    maxDate,
    safeName,
    splitRange,
    writeContributionReadme,
    writeDebugJson,
} from './contribution_helpers.js';

const MAX_REPOSITORIES_PER_BUCKET = 100;
const MIN_SPLIT_RANGE_MS = 60 * 60 * 1000;
const REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 5;

export async function updateContributionReadme(config) {
    const settings = {
        ...config,
        normalizedUsername: config.username.toLowerCase(),
        repoMaxDates: new Map(
            Object.entries(config.repoMaxDates ?? {}).map(([repo, date]) => [repo.toLowerCase(), new Date(date)])
        ),
        writeDebugFiles: !process.env.SKIP_FILE_DEBUG,
    };
    const client = createGithubClient(settings.token, {
        requestDelayMs: REQUEST_DELAY_MS,
        maxRetries: MAX_RETRIES,
    });
    const { owned, contributed } = await collectRepositories(settings, client);

    writeDebugJson(settings.writeDebugFiles, 'output/owned.json', owned);
    writeDebugJson(settings.writeDebugFiles, 'output/contributed.json', contributed);
    writeContributionReadme({ owned, contributed });

    console.log('\n\nResults:');
    console.log(`Private repos updated: ${owned.length}`);
    console.log(`Contributed repos updated: ${contributed.length}`);
}

async function collectRepositories(settings, client) {
    const repos = {
        ownedPrivate: new Map(),
        contributed: new Map(),
    };
    const pendingRanges = createMonthlyRanges(settings.historyStart, new Date());
    const saturatedRanges = [];
    let rangesProcessed = 0;
    let rangesSplit = 0;

    console.log('Fetching repositories...');

    while (pendingRanges.length > 0) {
        const range = pendingRanges.shift();
        const result = await client(listReposQuery, {
            login: settings.username,
            from: range.from.toISOString(),
            to: range.to.toISOString(),
        });
        writeDebugJson(
            settings.writeDebugFiles,
            `output/response_repos_${dateStamp(range.from)}_${dateStamp(range.to)}.json`,
            result
        );
        const coll = result.user.contributionsCollection;
        // Contribution groups: commits, issues, prs and reviews
        const buckets = [
            coll.commitContributionsByRepository,
            coll.issueContributionsByRepository,
            coll.pullRequestContributionsByRepository,
            coll.pullRequestReviewContributionsByRepository,
        ];
        // GitHub caps each contribution bucket at 100 repos. Split saturated ranges
        if (buckets.some(bucket => bucket.length >= MAX_REPOSITORIES_PER_BUCKET)) {
            const splitRanges = splitRange(range, MIN_SPLIT_RANGE_MS);
            if (splitRanges.length > 1) {
                pendingRanges.unshift(...splitRanges);
                rangesSplit++;
                process.stdout.write(`\rProcessed ${rangesProcessed} ranges, split ${rangesSplit} saturated ranges...`);
                continue;
            }
            saturatedRanges.push(range);
        }
        buckets.forEach(bucket => mergeContributionBucket(settings, repos, bucket, range.to));
        rangesProcessed++;
        process.stdout.write(`\rProcessed ${rangesProcessed} time ranges of repositories...`);
    }
    if (saturatedRanges.length > 0) {
        throw new Error(`Could not safely count all repositories; ` +
            `${saturatedRanges.length} range(s) still hit GitHub's ${MAX_REPOSITORIES_PER_BUCKET}-repository cap.`);
    }
    // Restricted/private contributions can exist without repo names in contributionsCollection
    await mergeAccessiblePrivateRepositories(settings, client, repos);

    console.log(`\nFound ${repos.ownedPrivate.size} private owned repositories`);
    console.log(`Found ${repos.contributed.size} contributed repositories`);

    return {
        owned: Array.from(repos.ownedPrivate.values()),
        contributed: Array.from(repos.contributed.values()),
    };
}

function mergeContributionBucket(settings, repos, bucket, rangeEnd) {
    bucket.forEach(item => {
        const target = targetSection(settings, repos, item.repository);
        if (!target) {
            return;
        }
        const cutoff = repoCutoff(settings, item.repository.nameWithOwner);
        // For normal repos, totalCount is enough. For snapshot repos, count the visible nodes manually
        const nodes = cutoff && rangeEnd > cutoff
            ? item.contributions.nodes.filter(node => isDateAllowed(node.occurredAt, cutoff))
            : item.contributions.nodes;
        const count = cutoff && rangeEnd > cutoff
            ? nodes.reduce((total, node) => total + (node.commitCount ?? 1), 0)
            : item.contributions.totalCount ?? 0;
        if (count === 0) {
            return;
        }
        const repo = target.get(item.repository.nameWithOwner) ?? makeRepoEntry(item.repository);
        const nodeDates = nodes
            .map(node => node.occurredAt ? new Date(node.occurredAt) : null)
            .filter(date => date && !Number.isNaN(date.getTime()));
        const latestContribution = nodeDates.length > 0 ? new Date(Math.max(...nodeDates)) : null;
        repo.count += count;
        repo.lastContributionDate = maxDate(
            repo.lastContributionDate,
            latestContribution ?? (cutoff && rangeEnd > cutoff ? cutoff : rangeEnd)
        );
        target.set(repo.nameWithOwner, repo);
    });
}

async function mergeAccessiblePrivateRepositories(settings, client, repos) {
    console.log('\nFetching accessible private repositories...');
    const privateRepos = new Map();
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
        const result = await client(privateReposQuery, { cursor });
        const connection = result.viewer.repositories;
        connection.nodes.forEach(repo => privateRepos.set(repo.nameWithOwner, repo));
        hasNextPage = connection.pageInfo.hasNextPage;
        cursor = connection.pageInfo.endCursor;
    }
    for (const [index, repo] of Array.from(privateRepos.values()).entries()) {
        process.stdout.write(`\rCounting private repository ${index + 1}/${privateRepos.size}...`);
        const target = targetSection(settings, repos, repo);
        if (!target || target.has(repo.nameWithOwner)) {
            continue;
        }
        const direct = await countDirectRepoContributions(settings, client, repo);
        if (direct.count === 0 && !isOwnRepo(settings, repo)) {
            continue;
        }
        target.set(repo.nameWithOwner, {
            ...makeRepoEntry(repo),
            count: direct.count,
            lastContributionDate: direct.lastContributionDate,
        });
    }
}

async function countDirectRepoContributions(settings, client, repo) {
    const dates = [];
    const cutoff = repoCutoff(settings, repo.nameWithOwner);
    let commitCursor = null;
    let prCursor = null;
    let issueCursor = null;
    let hasNextCommit = true;
    let hasNextPr = true;
    let hasNextIssue = true;
    while (hasNextCommit || hasNextPr || hasNextIssue) {
        const result = await client(repoDetailsQuery, {
            repoOwner: repo.owner.login,
            repoName: repo.name,
            commitCursor,
            prCursor,
            issueCursor,
        });
        writeDebugJson(settings.writeDebugFiles, `output/response_repo_${safeName(repo.nameWithOwner)}.json`, result);
        const history = result.repository.defaultBranchRef?.target?.history;
        const issues = result.repository.issues;
        const pullRequests = result.repository.pullRequests;
        if (history) {
            history.edges.forEach(edge => addIfMine(edge.node.author?.user?.login, edge.node.committedDate));
            hasNextCommit = history.pageInfo.hasNextPage;
            commitCursor = history.pageInfo.endCursor;
        } else {
            hasNextCommit = false;
        }
        issues.nodes.forEach(issue => addIfMine(issue.author?.login, issue.createdAt));
        pullRequests.nodes.forEach(pr => {
            addIfMine(pr.author?.login, pr.createdAt);
            pr.reviews.nodes.forEach(review => addIfMine(review.author?.login, review.submittedAt));
        });
        hasNextIssue = issues.pageInfo.hasNextPage;
        hasNextPr = pullRequests.pageInfo.hasNextPage;
        issueCursor = issues.pageInfo.endCursor;
        prCursor = pullRequests.pageInfo.endCursor;
    }
    return {
        count: dates.length,
        lastContributionDate: dates.length > 0 ? new Date(Math.max(...dates)) : null,
    };
    function addIfMine(login, dateValue) {
        if (login?.toLowerCase() === settings.normalizedUsername && isDateAllowed(dateValue, cutoff)) {
            dates.push(new Date(dateValue));
        }
    }
}

function targetSection(settings, repos, repo) {
    // Own public repos are accessible from GitHub directly
    if (isOwnRepo(settings, repo)) {
        return repo.isPrivate ? repos.ownedPrivate : null;
    }
    return repos.contributed;
}

function isOwnRepo(settings, repo) {
    return repo.owner.login.toLowerCase() === settings.normalizedUsername;
}

function makeRepoEntry(repo) {
    return {
        count: 0,
        name: repo.name,
        nameWithOwner: repo.nameWithOwner,
        url: repo.url,
        isPrivate: repo.isPrivate,
        lastContributionDate: null,
    };
}

function isDateAllowed(dateValue, cutoff) {
    if (!dateValue) {
        return false;
    }
    return !cutoff || new Date(dateValue) <= cutoff;
}

function repoCutoff(settings, nameWithOwner) {
    return settings.repoMaxDates.get(nameWithOwner.toLowerCase()) ?? null;
}
