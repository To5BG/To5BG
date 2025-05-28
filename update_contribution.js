const fs = require('fs');
const path = require('path');
const { graphql } = require('@octokit/graphql');

const GITHUB_TOKEN = process.env.GH_PAT;
const USERNAME = 'To5BG';

if (!GITHUB_TOKEN) {
  console.error('Missing GH_PAT environment variable');
  process.exit(1);
}

async function fetchPrivateRepos(graphqlWithAuth) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        repositories(first: 100, privacy: PRIVATE, ownerAffiliations: OWNER) {
          nodes {
            name
            isPrivate
          }
        }
      }
    }
  `;
  const result = await graphqlWithAuth(query, { login: USERNAME });
  return result.user.repositories.nodes
    .filter(repo => repo.isPrivate)
    .map(repo => repo.name);
}

async function fetchOtherContributions(graphqlWithAuth) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              owner {
                login
              }
              isPrivate
            }
          }
          pullRequestContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              owner {
                login
              }
              isPrivate
            }
          }
        }
      }
    }
  `;
  const result = await graphqlWithAuth(query, { login: USERNAME });
  const commitRepos = result.user.contributionsCollection.commitContributionsByRepository;
  const prRepos = result.user.contributionsCollection.pullRequestContributionsByRepository;

  const otherContribsMap = new Map();
  [...commitRepos, ...prRepos].forEach(({ repository }) => {
    if (!repository) return;
    if (repository.owner.login !== USERNAME) {
      otherContribsMap.set(repository.nameWithOwner, repository.url);
    }
  });
  return Array.from(otherContribsMap.entries());
}

async function fetchContributedRepos() {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
    },
  });
  const [privateRepos, otherContribs] = await Promise.all([
    fetchPrivateRepos(graphqlWithAuth),
    fetchOtherContributions(graphqlWithAuth)
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
  const readmePath = path.join(process.cwd(), 'README.md');
  let readmeContent = fs.readFileSync(readmePath, 'utf8');

  try {
    readmeContent = updatePrivateReposSection(readmeContent, repos.privateRepos);
    readmeContent = updateOtherContribsSection(readmeContent, repos.otherContribs);
    fs.writeFileSync(readmePath, readmeContent);
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
