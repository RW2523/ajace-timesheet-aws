// PM2 process file for the Timesheet app (AWS-native).
//   pm2 startOrReload ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "ajace-timesheet",
      cwd: "/home/ubuntu/ajace-timesheet-aws",
      script: "npm",
      args: "run start",              // next start -p 3009
      env: { NODE_ENV: "production" },
      max_memory_restart: "600M",

      autorestart: true,
      // Crash-loop protection. Without these, a process that dies instantly
      // (e.g. a missing .next build) gets restarted as fast as it can exit,
      // appending to ~/.pm2/logs without bound — which can fill the root
      // volume and take the whole box down. Back off, then give up so the
      // failure is visible in `pm2 status` instead of hidden in a loop.
      restart_delay: 5000,             // 5s between restarts
      exp_backoff_restart_delay: 200,  // ...growing if it keeps failing
      min_uptime: 10000,               // must survive 10s to count as healthy
      max_restarts: 10,                // then stop and stay stopped
      // install.sh also configures pm2-logrotate (10 MB x 5, compressed).
      merge_logs: true,
      time: true,
    },
  ],
};
