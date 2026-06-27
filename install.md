Here is the complete `INSTALL.md` file translated into English, ready to be placed at the root of your project.

# Production Installation Guide (Apache + systemd)

This guide describes the procedure to install, compile, and deploy **Bulwark Webmail** on a Linux server for production, using **systemd** for process management and **Apache** as a reverse proxy.



## Prerequisites

Before starting, ensure the following components are installed on your server:
* **Node.js** (v18.x or higher required for Next.js 16)
* **npm** (bundled with Node.js)
* **Apache2**



## 1. Preparing the Directory and Sources

Deploy the application source code into your system's standard web directory (e.g., `/var/www/bulwark-webmail`).

```bash
# Navigate to the parent directory
cd /var/www

# Clone the repository (or copy your production files)
git clone https://github.com/AurionMail/bulwarmail-e2e
cd bulwark-webmail

```

## 2. Environment Configuration (`.env.local`)

The application relies on an environment file named `.env.local` located **at the root of the project directory**. This file dictates runtime behavior.

Create the file:

```bash
nano .env.local

```

Add the following configuration, adjusting the values to match your infrastructure:

```env
# Local listen address and port for the Node.js process
HOSTNAME=127.0.0.1
PORT=3000

# JMAP configuration for your Stalwart mail server
JMAP_SERVER_URL=https://mail.your-domain.com
APP_NAME="Bulwark Webmail"
STALWART_FEATURES=true

# Secret session key (Generate a unique one via: openssl rand -base64 32)
SESSION_SECRET="INSERT_YOUR_SECURE_RANDOM_KEY_HERE"

# Local application data storage paths
SETTINGS_SYNC_ENABLED=true
SETTINGS_DATA_DIR=./data/settings
ADMIN_CONFIG_DIR=./data/admin
ADMIN_STATE_DIR=./data/admin-state
ADMIN_CONFIG_READONLY=false

# Logging configuration
LOG_FORMAT=text
LOG_LEVEL=info

```



## 3. Dependencies, Permissions, and Compilation (Build)

The Next.js build pipeline compiles the source code and outputs an optimized production bundle inside the hidden **`.next/`** folder.

> ⚠️ **Important:** The `.next/`, `node_modules/`, and `public/` directories must remain managed by the application. **Do not** expose them directly via an Apache `DocumentRoot`. The internal Node server handles serving these assets via port `3000`.

Set up the permissions so that the standard web server system user (`www-data`) owns the required files:

```bash
# Create the data directories defined in .env.local
mkdir -p data/settings data/admin data/admin-state

# Assign full directory ownership to the www-data user
chown -R www-data:www-data /var/www/bulwark-webmail

# Install production dependencies and run the build as the www-data user
sudo -u www-data npm install --omit=dev
sudo -u www-data npm run build

```



## 4. Systemd Service Configuration

To keep the application running continuously in the background and ensure it automatically restarts on system reboots, create a systemd service file.

Create the service configuration file:

```bash
sudo nano /etc/systemd/system/bulwark-webmail.service

```

Insert the following contents:

```ini
[Unit]
Description=Bulwark Webmail Service
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/bulwark-webmail
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=bulwark-webmail
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target

```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bulwark-webmail
sudo systemctl start bulwark-webmail

```

You can verify the runtime status of the service using:

```bash
sudo systemctl status bulwark-webmail

```



## 5. Apache Reverse Proxy Configuration

Apache will intercept public HTTPS traffic on port `443` and route it locally to the Next.js application server running on port `3000`.

### Enable Required Apache Modules

Enable the necessary modules for HTTP proxying and WebSockets handling:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers

```

### Configure the VirtualHost

Create a new site configuration file:

```bash
sudo nano /etc/apache2/sites-available/webmail.conf

```

Add the following configuration blocks (adjust the `ServerName` and your SSL certificate paths):

```apache
<VirtualHost *:80>
    ServerName mail.your-domain.com

    ProxyRequests Off
    ProxyPreserveHost On
    ProxyVia Full

    <Proxy *>
        Require all granted
    </Proxy>

    # Routing rules for Next.js WebSockets (handled before standard HTTP)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/(.*)           ws://127.0.0.1:3000/$1 [P,L]

    # Standard HTTP reverse proxy to the local instance
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/

    # Security headers for proxied sessions
    RequestHeader set X-Forwarded-Proto "http"
    RequestHeader set X-Forwarded-Port "80"

    # Apache Logging
    ErrorLog ${APACHE_LOG_DIR}/bulwark_error.log
    CustomLog ${APACHE_LOG_DIR}/bulwark_access.log combined
</VirtualHost>

```

### Activate the Site and Reload Apache

Enable the configuration and reload the Apache service daemon:

```bash
sudo a2ensite webmail.conf
sudo systemctl restart apache2

```