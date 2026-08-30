module.exports = {
  apps: [
    {
      name: 'bottom-line-work-backend',
      script: 'server.js',
      cwd: __dirname + '\\backend',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000
    },
    {
      name: 'bottom-line-work-frontend',
      script: __dirname + '\\frontend\\start-dev.bat',
      interpreter: 'cmd',
      interpreter_args: '/c',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
};
