# HPC connection

Codeome uses your system `ssh`, so `~/.ssh/config`, keys, ProxyJump and the VPN behave exactly as in iTerm2 (or, with Codeome's own VPN tunnel, only Codeome's HPC connections use the VPN; see [Settings](/settings)). You log in once, in the background: with an ssh key nothing is asked, and a password, key passphrase, one-time code or new host fingerprint is asked for in a dialog, so the terminal panel stays free for your own work. Every other operation reuses that connection for 12 hours. If the background login fails, its log offers to try again in a terminal tab. The title bar shows VPN reachability, connection state and your running / waiting / failed jobs.

To set the HPC login and network, see [Settings](/settings).

<Shot src="/screens/settings-hpc.png" alt="Settings HPC page with a setup checklist: OpenConnect installed, VPN tunnel not running with a Start button, ssh key with a Create key button and Connected with a Connect button" caption="The setup checklist in Settings → HPC marks each step done or open and offers its button: Start, Create key or Connect." width="1500" height="940" />

<Shot src="/screens/vpn.png" alt="A Sign in to vpn.example.org dialog asking for a VPN username over the HPC settings" caption="With Codeome's own VPN tunnel, starting the connection asks for anything not saved, here the VPN username, in a dialog." width="1500" height="940" />

<Shot bare src="/screens/detail-vpn-prompt.png" alt="Dialog Sign in to vpn.example.org with a Username field, a Remember it in Settings checkbox and Cancel and Continue buttons" caption="The dialog can remember the username in Settings." width="584" height="238" />
