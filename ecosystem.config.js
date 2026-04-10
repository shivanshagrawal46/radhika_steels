module.exports = {
  apps: [
    {
      name: "radhika-steel",
      script: "server.js",
      cwd: "/steel/radhika_steel/radhika_steels",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
