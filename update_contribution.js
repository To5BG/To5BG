import { readFileSync, writeFileSync } from 'fs';
import { graphql } from '@octokit/graphql';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { listReposQuery, repoDetailsQuery } from './queries/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const GITHUB_TOKEN = process.env.GH_PAT;
const USERNAME = 'To5BG';

if (!GITHUB_TOKEN) {
    console.error('Missing GitHub token');
    process.exit(1);
}

const graphqlWithAuth = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
    return graphql.defaults({
        headers: {
            authorization: `token ${GITHUB_TOKEN}`,
        },
    })(...args);
};

function writeDebugFile(filePath, content) {
    if (!process.env.SKIP_FILE_DEBUG) {
        fs.mkdirSync('output', { recursive: true });
        fs.writeFileSync(filePath, SON.stringify(content, null, 2), 'utf-8');
    }
}

async function getAllRepositories() {
    const privateOwnedRepos = new Map();
    const publicOwnedRepos = new Map();
    const otherContributedRepos = new Map();
    let rangesProcessed = 0;

    let to = new Date();
    let from = new Date(0);
    from.setUTCMilliseconds(to - 15780000000);

    console.log('Fetching repositories...');

    while (true) {
        const fromISO = from.toISOString();
        const toISO = to.toISOString();

        const result = await graphqlWithAuth(listReposQuery, {
            login: USERNAME,
            from: fromISO,
            to: toISO,
        });

        writeDebugFile('output/response_repos.json', result);

        const coll = result.user.contributionsCollection;
        const arr = [
            coll.commitContributionsByRepository,
            coll.issueContributionsByRepository,
            coll.pullRequestContributionsByRepository,
            coll.pullRequestReviewContributionsByRepository
        ];

        for (let col of arr) {
            col.forEach(i => {
                const repo = i.repository;
                const map = (repo.owner.login == USERNAME && repo.isPrivate) ? privateOwnedRepos :
                    (repo.owner.login == USERNAME) ? publicOwnedRepos : otherContributedRepos;

                const [prevCount = 0, repoUrl = repo.url] = map.get(repo.nameWithOwner) || [];
                map.set(repo.nameWithOwner, [prevCount + (i?.contributions?.totalCount ?? 1), repoUrl]);
            });
        }

        if (!coll.hasActivityInThePast) break;
        to = new Date(from);
        from = new Date(0);
        from.setUTCMilliseconds(to - 15780000000);

        rangesProcessed++;
        process.stdout.write(`\rProcessed ${rangesProcessed} time ranges of repositories...`);
        process.stdout.write(from.toISOString());
    }

    console.log(`\nFound ${privateOwnedRepos.size} private owned repositories`);
    console.log(`Found ${otherContributedRepos.size} contributed repositories`);

    return {
        owned: Array.from(privateOwnedRepos.values()),
        contributed: Array.from(otherContributedRepos.values())
    };
}

async function getLastContributionDate(repoOwner, repoName) {
    const dates = [];

    let commitCursor = null;
    let prCursor = null;
    let issueCursor = null;

    let hasNextCommit = true;
    let hasNextPr = true;
    let hasNextIssue = true;

    try {
        while (hasNextCommit || hasNextPr || hasNextIssue) {
            const result = await graphqlWithAuth(repoDetailsQuery, {
                repoOwner,
                repoName,
                commitCursor,
                prCursor,
                issueCursor
            });

            writeDebugFile(`output/response_repo_${repoOwner.toLowerCase()}_${repoName.toLowerCase()}.json`,
                result);

            const history = result.repository.defaultBranchRef?.target?.history;
            if (!history) break;

            history.edges.forEach(o => {
                if (o.node.author?.user?.login === USERNAME)
                    dates.push(new Date(o.node.committedDate));
            });

            result.repository.issues.nodes.forEach(issue => {
                if (issue.author?.login === USERNAME)
                    dates.push(new Date(issue.createdAt));

                issue.comments.nodes.forEach(comment => {
                    if (comment.author?.login === USERNAME)
                        dates.push(new Date(comment.createdAt));
                });
            });

            result.repository.pullRequests.nodes.forEach(pr => {
                if (pr.author?.login === USERNAME)
                    dates.push(new Date(pr.createdAt));

                pr.comments.nodes.forEach(comment => {
                    if (comment.author?.login === USERNAME)
                        dates.push(new Date(comment.createdAt));
                });
                pr.reviews.nodes.forEach(review => {
                    if (review.author?.login === USERNAME && review.submittedAt)
                        dates.push(new Date(review.submittedAt));
                });
            });

            hasNextCommit = history.pageInfo.hasNextPage;
            hasNextIssue = result.repository.issues.pageInfo.hasNextPage;
            hasNextPr = result.repository.pullRequests.pageInfo.hasNextPage;

            commitCursor = history.pageInfo.endCursor;
            issueCursor = result.repository.issues.pageInfo.endCursor;
            prCursor = result.repository.pullRequests.pageInfo.endCursor;

            process.stdout.write('.');
            if (dates.length > 0) return new Date(Math.max(...dates));
        }
        return null;
    } catch (error) {
        console.error(`\nError processing ${repoOwner}/${repoName}:`, error.message);
        return null;
    }
}

async function processRepositories() {
    try {
        const { owned, contributed } = await getAllRepositories();
        writeDebugFile('output/owned.json', owned);
        writeDebugFile('output/contributed.json', contributed);

        console.log('\nProcessing private owned repositories...');
        const ownedWithDates = await Promise.all(
            owned.map(async (repo, index) => {
                process.stdout.write(`\rProcessing ${index + 1}/${owned.length}...`);
                const [, , , owner, name] = repo[1].split("/");
                const lastContributionDate = await getLastContributionDate(owner, name);
                return {
                    nameWithOwner: `${owner}/${name}`, count: repo[0], url: repo[1],
                    lastContributionDate
                };
            })
        );

        console.log('\n\nProcessing contributed repositories...');
        const contributedWithDates = await Promise.all(
            contributed.map(async (repo, index) => {
                process.stdout.write(`\rProcessing ${index + 1}/${contributed.length}...`);
                const [, , , owner, name] = repo[1].split("/");
                const lastContributionDate = await getLastContributionDate(owner, name);
                return {
                    nameWithOwner: `${owner}/${name}`, count: repo[0], url: repo[1],
                    lastContributionDate
                };
            })
        );

        // Update README
        const readmePath = join(__dirname, 'README.md');
        let readme = readFileSync(readmePath, 'utf8');

        const privateSection = ownedWithDates
            .sort((a, b) => b.lastContributionDate - a.lastContributionDate)
            .map(repo => `- [${repo.count}]${repo.nameWithOwner}`)
            .join('\n');
        readme = readme.replace(
            /<!-- PRIVATE_REPOS_START -->[\s\S]*?<!-- PRIVATE_REPOS_END -->/,
            `<!-- PRIVATE_REPOS_START -->\n${privateSection}\n<!-- PRIVATE_REPOS_END -->`
        );

        const contributedSection = contributedWithDates
            .sort((a, b) => b.lastContributionDate - a.lastContributionDate)
            .map(repo => `- [${repo.count}][${repo.nameWithOwner}](${repo.url})`)
            .join('\n');
        readme = readme.replace(
            /<!-- OTHER_CONTRIBS_START -->[\s\S]*?<!-- OTHER_CONTRIBS_END -->/,
            `<!-- OTHER_CONTRIBS_START -->\n${contributedSection}\n<!-- OTHER_CONTRIBS_END -->`
        );

        writeFileSync(readmePath, readme);

        console.log('\n\nResults:');
        console.log(`Private repos updated: ${owned.length}`);
        console.log(`Contributed repos updated: ${contributed.length}`);
    } catch (error) {
        console.error('\nError:', error.message);
        if (error.errors) {
            console.error('GraphQL Errors:', JSON.stringify(error.errors, null, 2));
        }
        process.exit(1);
    }
}

processRepositories();
