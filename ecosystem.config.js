// PM2 process config. Deploy with:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2-startup install   (one-time, to survive reboots)
module.exports = {
  apps: [{
    name: 'valueTool',
    script: './server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
