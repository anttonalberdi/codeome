# HPC connection

Codeome uses your system `ssh`, so `~/.ssh/config`, keys, ProxyJump and the VPN behave exactly as in iTerm2 (or, with Codeome's own VPN tunnel, only Codeome's HPC connections use the VPN; see [Settings](/settings)). You log in once, in the background: with an ssh key nothing is asked, and a password, key passphrase, one-time code or new host fingerprint is asked for in a dialog, so the terminal panel stays free for your own work. Every other operation reuses that connection for 12 hours. If the background login fails, its log offers to try again in a terminal tab. The title bar shows VPN reachability, connection state and your running / waiting / failed jobs.

To set the HPC login and network, see [Settings](/settings).
