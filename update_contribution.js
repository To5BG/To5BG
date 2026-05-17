import { updateContributionReadme } from './contribution_utils.js';

const CONFIG = {
    token: process.env.GH_PAT,
    username: 'To5BG',
    historyStart: new Date(Date.UTC(2021, 11, 30)),
    // Repos in this map are treated as snapshots: contributions after the date are ignored
    repoMaxDates: {
        'CSE3000-research-project/cse3000-research-project.github.io': '2025-01-31T23:59:59Z',
    },
};

if (!CONFIG.token) {
    console.error('Missing GitHub token');
    process.exit(1);
}

updateContributionReadme(CONFIG).catch(error => {
    console.error('\nError:', error.message);
    if (error.errors) {
        console.error('GraphQL Errors:', JSON.stringify(error.errors, null, 2));
    }
    process.exit(1);
});
