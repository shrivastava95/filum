# Filum

Filum gives you a flow:

1. **Gather** — capture all the tasks currently occupying your mind.
3. **Choose the order** — move tasks into a usable sequence and optionally add rough durations.
4. **Follow the thread** — focus on one task at a time.

It is useful when you have too many competing tasks and need a calm, local, minimal way to convert them into a sequence.

## A quick look

![Filum — Step 1: gather your tasks while a thread quietly tangles alongside them](assets/images/demo.png)

## Requirements

You need:

- A Unix/Linux based system, or macOS
- Node.js `18` or newer


## setup

### 1. Install system dependencies

install Node.js 18+ using your preferred method.

```bash
sudo apt install -y nodejs
node --version
```
Make sure the version is `v18.x` or newer.


On macOS with Homebrew:

```bash
brew install git node
node --version
```

### 2. Clone the repository

```bash
git clone https://github.com/ManikSinghSarmaal/filum.git
cd filum
```

### 3. Run the local server

```bash
node server.js
```

You should see something like:

```text
[filum] serving on http://localhost:4317
[filum] threads at /home/<user>/.filum/threads
```

Now open the app in your browser:

```text
http://localhost:4317
```

## Storage

By default, Filum stores your saved threads here:

```bash
~/.filum/threads
```

Each thread is stored as a separate `.json` file.

To use a custom storage directory:

```bash
FILUM_THREADS_DIR=/path/to/my/filum-threads node server.js
```

Example:

```bash
mkdir -p ~/Documents/filum-threads
FILUM_THREADS_DIR=~/Documents/filum-threads node server.js
```

## Custom port

The default port is `4317`.

To run Filum on another port:

```bash
FILUM_PORT=8080 node server.js
```

Then open:

```text
http://localhost:8080
```

You can combine custom port and custom storage:

```bash
FILUM_PORT=8080 FILUM_THREADS_DIR=~/Documents/filum-threads node server.js
```

## Optional: Google sign-in and encrypted server storage

If you want user accounts, set these environment variables before starting the server:

```bash
GOOGLE_CLIENT_ID=your-google-oauth-client-id
FILUM_MASTER_KEY=$(openssl rand -base64 32)
node server.js
```

When `GOOGLE_CLIENT_ID` is set, Filum switches to account mode:

- users sign in with Google only
- each account gets its own thread store
- user records and thread records are encrypted at rest on the server

This protects the stored files from a simple disk or database leak. It does not make the server cryptographically safe if the running process or the host is compromised.

## Optional: create a small launcher script

From inside the repo:

```bash
cat > run-filum.sh <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
node server.js
SCRIPT

chmod +x run-filum.sh
./run-filum.sh
```

Now you can start Filum with:

```bash
./run-filum.sh
```

## Optional: run Filum in the background

For a simple background run:

```bash
nohup node server.js > filum.log 2>&1 &
```

Check logs:

```bash
tail -f filum.log
```

Stop it:

```bash
pkill -f "node server.js"
```

## Optional: systemd service on Linux

If you want Filum to start automatically on boot, create a user-level systemd service.

First, get the absolute path of the repo:

```bash
pwd
```

Then create the service file:

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/filum.service
```

Paste this, replacing `/absolute/path/to/filum` with your actual repo path:

```ini
[Unit]
Description=Filum local thread server
After=network.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/filum
ExecStart=/usr/bin/env node server.js
Restart=on-failure
Environment=FILUM_PORT=4317

[Install]
WantedBy=default.target
```

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now filum.service
```

Check status:

```bash
systemctl --user status filum.service
```

View logs:

```bash
journalctl --user -u filum.service -f
```
