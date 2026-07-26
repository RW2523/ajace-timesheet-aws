// PM2 process file — BOTH AJACE apps on one box.
//   pm2 startOrReload ecosystem.config.cjs && pm2 save && pm2 startup
//
// Memory limits matter here: 2 GB total, and swapon does not work on this
// kernel, so a runaway process must be restarted rather than allowed to invoke
// the OOM killer (which would take the other app down with it).
const common = {
  env: { NODE_ENV: "production" },
  autorestart: true,
  restart_delay: 5000,
  exp_backoff_restart_delay: 200,
  min_uptime: 10000,
  max_restarts: 10,
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "ajace-timesheet",
      cwd: "/home/ubuntu/ajace-timesheet-aws",
      script: "npm",
      args: "run start",              // next start -p 3009
      max_memory_restart: "600M",
    },
    {
      ...common,
      name: "ajace-procurement",
      cwd: "/home/ubuntu/procurement-intelligence-platform",
      script: "npm",
      args: "run start -- -p 3002",
      // Roomier: crawls parse HTML and buffer attachments. Still bounded so it
      // can never starve the timesheet app during payroll.
      max_memory_restart: "700M",
    },
  ],
};
