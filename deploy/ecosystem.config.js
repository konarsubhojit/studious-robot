module.exports = {
  apps: [
    {
      name: 'robot-signal',
      script: 'src/index.ts',
      cwd: '/home/ubuntu/repos/studious-robot/server',
      interpreter: '/usr/bin/node',
      exec_mode: 'fork',
      instances: Number(process.env.PM2_INSTANCES || 6),
      increment_var: 'PORT',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '4173',
      },
      kill_timeout: 30000,
    },
  ],
};
