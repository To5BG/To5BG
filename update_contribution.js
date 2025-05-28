const fs = require('fs');
const path = require('path');
const { graphql } = require('@octokit/graphql');

const GITHUB_TOKEN = process.env.GH_PAT;
const USERNAME = 'To5BG';

if (!GITHUB_TOKEN) {
  console.error('Missing GH_PAT environment variable');
  process.exit(1);
}

async function fetchContributedRepos() {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
    },
  });

  const query = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        commitContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
          }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
          }
        }
      }
    }
  }
  `;

  const result = await graphqlWithAuth(query, { login: USERNAME });

  const commitRepos = result.user.contributionsCollection.commitContributionsByRepository;
  const prRepos = result.user.contributionsCollection.pullRequestContributionsByRepository;

  // Combine and deduplicate
  const allReposMap = new Map();
  [...commitRepos, ...prRepos].forEach(({ repository }) => {
    allReposMap.set(repository.nameWithOwner, repository.url);
  });

  return Array.from(allReposMap.entries());
}

function updateReadme(contributedRepos) {
  const readmePath = path.join(process.cwd(), 'README.md');
  let readmeContent = fs.readFileSync(readmePath, 'utf8');

  const startMarker = '<!-- CONTRIBUTED_REPOS_START -->';
  const endMarker = '<!-- CONTRIBUTED_REPOS_END -->';

  const listMd = contributedRepos
    .map(([nameWithOwner, url]) => `- [${nameWithOwner}](${url})`)
    .join('\n');

  const replacement = `${startMarker}\n${listMd}\n${endMarker}`;

  const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm');

  if (!regex.test(readmeContent)) {
    console.error('Markers not found in README.md');
    process.exit(1);
  }

  readmeContent = readmeContent.replace(regex, replacement);

  fs.writeFileSync(readmePath, readmeContent);
  console.log('README.md updated with contributed repos');
}

async function main() {
  const repos = await fetchContributedRepos();
  updateReadme(repos);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
