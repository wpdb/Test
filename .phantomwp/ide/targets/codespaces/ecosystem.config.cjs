// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

const path = require('path');
const projectRoot = path.join(__dirname, '..', '..', '..', '..');

module.exports = {
  apps: [
    {
      name: 'websocket',
      script: path.join(projectRoot, '.devcontainer', 'ws-server.js'),
      cwd: projectRoot,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: '/tmp/ws-server-error.log',
      out_file: '/tmp/ws-server.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      node_args: '--experimental-modules',
      env: {
        NODE_ENV: 'development',
        // Set by startup.sh (fetched from main app or GitHub Codespaces Secrets)
        JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY || '',
        // Used by ws-server.js to periodically refresh public keys
        PHANTOMWP_URL: process.env.PHANTOMWP_URL || 'https://phantomwp.com',
      },
    },
    {
      name: 'astro',
      script: 'npm',
      args: 'run dev',
      cwd: projectRoot,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/tmp/astro-error.log',
      out_file: '/tmp/astro.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'development',
        // Allow Codespaces reverse proxy hostname for Vite 6.2+ allowedHosts check
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.app.github.dev',
      },
    },
  ],
};
