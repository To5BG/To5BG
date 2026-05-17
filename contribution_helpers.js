import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { graphql } from '@octokit/graphql';
import { fileURLToPath } from 'url';
import { join } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function createGithubClient(token, { requestDelayMs, maxRetries }) {
    const githubGraphql = graphql.defaults({
        headers: {
            authorization: `token ${token}`,
        },
    });
    return async (...args) => {
        for (let attempt = 0; ; attempt++) {
            try {
                await delay(requestDelayMs);
                return await githubGraphql(...args);
            } catch (error) {
                if (attempt >= maxRetries) {
                    throw error;
                }
                const backoffMs = Math.min(30000, requestDelayMs * (2 ** (attempt + 1)));
                console.warn(`\nGraphQL request failed (${error.message}). Retrying in ${backoffMs}ms...`);
                await delay(backoffMs);
            }
        }
    };
}

export function createMonthlyRanges(start, end) {
    const ranges = [];
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    // Fixed month boundaries make repeated runs deterministic
    while (cursor < end) {
        const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
        ranges.push({
            from: new Date(cursor),
            to: next < end ? next : new Date(end),
        });
        cursor = next;
    }
    return ranges.reverse();
}

export function splitRange({ from, to }, minRangeMs) {
    const fromTime = from.getTime();
    const toTime = to.getTime();
    if (toTime - fromTime <= minRangeMs) {
        return [{ from, to }];
    }
    const midpoint = new Date(Math.floor((fromTime + toTime) / 2));
    return [
        { from: midpoint, to },
        { from, to: midpoint },
    ];
}

export function writeContributionReadme({ owned, contributed }) {
    const readmePath = join(__dirname, 'README.md');
    let readme = readFileSync(readmePath, 'utf8');
    // Only replace the generated blocks; leave the hand-written README untouched
    readme = replaceSection(readme, 'PRIVATE_REPOS', renderRepoList(owned, repo => repo.name));
    readme = replaceSection(
        readme,
        'OTHER_CONTRIBS',
        renderRepoList(contributed, repo => repo.isPrivate ? repo.nameWithOwner : `[${repo.nameWithOwner}](${repo.url})`)
    );
    writeFileSync(readmePath, readme);
}

export function writeDebugJson(enabled, filePath, content) {
    if (!enabled) {
        return;
    }
    mkdirSync('output', { recursive: true });
    writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

export function maxDate(current, candidate) {
    if (!candidate) {
        return current;
    }
    if (!current || candidate > current) {
        return new Date(candidate);
    }
    return current;
}

export function dateStamp(date) {
    return date.toISOString().slice(0, 10);
}

export function safeName(nameWithOwner) {
    return nameWithOwner.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

function replaceSection(readme, marker, content) {
    return readme.replace(
        new RegExp(`<!-- ${marker}_START -->[\\s\\S]*?<!-- ${marker}_END -->`),
        `<!-- ${marker}_START -->\n${content}\n<!-- ${marker}_END -->`
    );
}

function renderRepoList(repos, labelForRepo) {
    const wspace = '\u00A0';
    return repos
        .sort(compareRepos)
        .map(repo => {
            const spacing = wspace.repeat(Math.max(1, 7 - 2 * repo.count.toString().length));
            return `- [${repo.count}]${spacing}${labelForRepo(repo)}`;
        })
        .join('\n');
}

function compareRepos(a, b) {
    const dateDiff = b.lastContributionDate - a.lastContributionDate;
    if (dateDiff !== 0) {
        return dateDiff;
    }
    const countDiff = b.count - a.count;
    if (countDiff !== 0) {
        return countDiff;
    }
    return a.nameWithOwner.localeCompare(b.nameWithOwner);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
