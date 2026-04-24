module.exports = {
  apps: [
    {
      name: 'tg-bot',
      script: 'reports/bot-server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      cwd: '/root/bot',
      env: {
        NODE_ENV: 'production',
      },
      // Auto-restart on crash
      restart_delay: 5000,
      max_restarts: 20,
      // Logs
      out_file: '/root/bot/logs/bot-out.log',
      error_file: '/root/bot/logs/bot-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Memory limit — restart if over 300 MB
      max_memory_restart: '300M',
    },
  ],
};
