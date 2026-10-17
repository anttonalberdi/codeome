import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Codeome',
  description:
    'One Mac app for R/Python work on your laptop and HPC: editor, terminals, Claude Code & Codex sessions, Slurm, file transfer, reports, GitHub, Zenodo and PyPI.',
  base: '/codeome/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/codeome/favicon.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Settings', link: '/settings' },
      { text: 'Reference', link: '/reference/keyboard' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Projects', link: '/guide/projects' },
          { text: 'Editor', link: '/guide/editor' },
          { text: 'Terminals', link: '/guide/terminals' },
          { text: 'Plots', link: '/guide/plots' },
          { text: 'Agent chat', link: '/guide/agent-chat' },
          { text: 'Forum & Ideas', link: '/guide/forum-ideas' },
          { text: 'Team', link: '/guide/team' },
          { text: 'HPC', link: '/guide/hpc' },
          { text: 'Files & transfer', link: '/guide/files-transfer' },
          { text: 'Slurm', link: '/guide/slurm' },
          { text: 'Reports', link: '/guide/reports' },
          { text: 'Git & GitHub', link: '/guide/git-github' },
          { text: 'Publishing', link: '/guide/publishing' },
          { text: 'Secrets', link: '/guide/secrets' }
        ]
      },
      { text: 'Settings', items: [{ text: 'Settings', link: '/settings' }] },
      {
        text: 'Reference',
        items: [
          { text: 'Keyboard shortcuts', link: '/reference/keyboard' },
          { text: 'Agent kit', link: '/reference/agent-kit' },
          { text: 'Project layout', link: '/reference/project-layout' }
        ]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/anttonalberdi/codeome' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/anttonalberdi/codeome/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },
    outline: [2, 3]
  }
})
