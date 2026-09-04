module.exports = {
  apps: [{
      name: 'robot-signal',
      script: './start.sh',
      cwd: '/home/wetalk/repos/studious-robot/server',
      instances: 6, // single-instance host: 1
      exec_mode: 'fork',
      increment_var: 'PORT', // single-instance host: omit
      env: { PORT: 4173, HOST: '127.0.0.1' },
      kill_timeout: 30000,
      listen_timeout: 15000,
      max_memory_restart: '1G',
      merge_logs: true,
    }]
}
