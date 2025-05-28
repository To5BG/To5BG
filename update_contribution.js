import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { graphql } from '@octokit/graphql';
import { privateReposQuery, contributionsQuery } from './queries/index.js';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GITHUB_TOKEN = process.env.GH_PAT;
const USERNAME = 'To5BG';

if (!GITHUB_TOKEN) {
  console.error('Missing GH_PAT environment variable');
  process.exit(1);
}

async function fetchAllPrivateRepos(graphqlWithAuth) {
  const allRepos = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const result = await graphqlWithAuth(privateReposQuery, { login: USERNAME, cursor });
    const { nodes, pageInfo } = result.user.repositories;
    allRepos.push(...nodes);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  return allRepos
    .filter(repo => repo.isPrivate)
    .map(repo => ({
      name: repo.name,
      lastUpdate: repo.defaultBranchRef?.target?.committedDate || repo.pushedAt
    }))
    .sort((a, b) => new Date(b.lastUpdate) - new Date(a.lastUpdate))
    .map(repo => repo.name);
}

async function fetchAllContributions(graphqlWithAuth) {
  const allContribs = new Map();
  let hasNextPageCommits = true;
  let hasNextPagePRs = true;
  let cursorCommits = null;
  let cursorPRs = null;

  while (hasNextPageCommits || hasNextPagePRs) {
    const result = await graphqlWithAuth(contributionsQuery, {
      login: USERNAME,
      cursorCommits,
      cursorPRs
    });
    const commitData = result.user.contributionsCollection.commitContributionsByRepository;
    const prData = result.user.contributionsCollection.pullRequestContributionsByRepository;
    // Process commit contributions
    if (hasNextPageCommits) {
      commitData.nodes.forEach(({ repository }) => {
        if (!repository || repository.owner.login === USERNAME) return;
        const lastCommitDate = repository.defaultBranchRef?.target?.history?.nodes?.[0]?.committedDate;
        if (!allContribs.has(repository.nameWithOwner) ||
          (lastCommitDate && new Date(lastCommitDate) > new Date(allContribs.get(repository.nameWithOwner).lastUpdate))) {
          allContribs.set(repository.nameWithOwner, {
            url: repository.url,
            lastUpdate: lastCommitDate || new Date(0).toISOString()
          });
        }
      });
      hasNextPageCommits = commitData.pageInfo.hasNextPage;
      cursorCommits = commitData.pageInfo.endCursor;
    }
    // Process PR contributions
    if (hasNextPagePRs) {
      prData.nodes.forEach(({ repository }) => {
        if (!repository || repository.owner.login === USERNAME) return;
        const lastCommitDate = repository.defaultBranchRef?.target?.history?.nodes?.[0]?.committedDate;
        if (!allContribs.has(repository.nameWithOwner) ||
          (lastCommitDate && new Date(lastCommitDate) > new Date(allContribs.get(repository.nameWithOwner).lastUpdate))) {
          allContribs.set(repository.nameWithOwner, {
            url: repository.url,
            lastUpdate: lastCommitDate || new Date(0).toISOString()
          });
        }
      });
      hasNextPagePRs = prData.pageInfo.hasNextPage;
      cursorPRs = prData.pageInfo.endCursor;
    }
  }
  return Array.from(allContribs.entries())
    .map(([name, data]) => ({
      name,
      url: data.url,
      lastUpdate: data.lastUpdate
    }))
    .sort((a, b) => new Date(b.lastUpdate) - new Date(a.lastUpdate))
    .map(repo => [repo.name, repo.url]);
}

async function fetchContributedRepos() {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
    },
  });
  const [privateRepos, otherContribs] = await Promise.all([
    fetchAllPrivateRepos(graphqlWithAuth),
    fetchAllContributions(graphqlWithAuth)
  ]);
  return { privateRepos, otherContribs };
}

function updatePrivateReposSection(readmeContent, privateRepos) {
  const startMarker = '<!-- PRIVATE_REPOS_START -->';
  const endMarker = '<!-- PRIVATE_REPOS_END -->';
  const listMd = privateRepos
    .map(name => `- ${name}`)
    .join('\n');
  const replacement = `${startMarker}\n${listMd}\n${endMarker}`;
  const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm');

  if (!regex.test(readmeContent)) {
    throw new Error('Private repos section markers not found in README.md');
  }

  return readmeContent.replace(regex, replacement);
}

function updateOtherContribsSection(readmeContent, otherContribs) {
  const startMarker = '<!-- OTHER_CONTRIBS_START -->';
  const endMarker = '<!-- OTHER_CONTRIBS_END -->';
  const listMd = otherContribs
    .map(([nameWithOwner, url]) => `- [${nameWithOwner}](${url})`)
    .join('\n');
  const replacement = `${startMarker}\n${listMd}\n${endMarker}`;
  const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm');

  if (!regex.test(readmeContent)) {
    throw new Error('Other contributions section markers not found in README.md');
  }

  return readmeContent.replace(regex, replacement);
}

function updateReadme(repos) {
  const readmePath = join(__dirname, 'README.md');
  let readmeContent = readFileSync(readmePath, 'utf8');

  try {
    readmeContent = updatePrivateReposSection(readmeContent, repos.privateRepos);
    readmeContent = updateOtherContribsSection(readmeContent, repos.otherContribs);
    writeFileSync(readmePath, readmeContent);
    console.log('README.md updated successfully');
  } catch (error) {
    console.error('Error updating README.md:', error.message);
    process.exit(1);
  }
}

async function main() {
  try {
    const repos = await fetchContributedRepos();

    console.log(`Found ${repos.privateRepos.length} private repositories and ${repos.otherContribs.length} other contributions`);
    console.log('\nPrivate repositories:');
    repos.privateRepos.forEach(name => {
      console.log(`- ${name}`);
    });
    console.log('\nOther contributions:');
    repos.otherContribs.forEach(([nameWithOwner, url]) => {
      console.log(`- ${nameWithOwner}: ${url}`);
    });

    updateReadme(repos);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
