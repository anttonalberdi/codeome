# Phone companion

The phone companion is a small web page that Codeome serves to your phone over [Tailscale](https://tailscale.com). While you are away from the Mac, it lets you:

- answer the agent's decisions (allow once, deny, or answer a question);
- send a message to a chat;
- stop a chat;
- read the chat's full log, and load the full result of a tool call.

It cannot start new chats, cannot give "always allow" permissions, never shows your [secrets](/guide/secrets), and approves only low-risk actions (see [What the phone may approve](#what-the-phone-may-approve)). Everything else waits for the Mac. The Mac must stay on and running Codeome: the phone talks to it, not to Anthropic or the HPC.

## Set up

You need Tailscale on the Mac and on the phone, signed in to the same tailnet.

1. Open **Settings → Phone companion** and tick *Enable phone companion*. A **Phone** indicator appears in the title bar; click it to come back to this page.
2. Choose the **Mode**:
   - *Tailscale Serve · HTTPS, installable PWA* (default). Codeome listens on `127.0.0.1` only, and Tailscale Serve publishes it on your tailnet over HTTPS. Choose this one if you want to add the page to the home screen.
   - *Tailnet IP · plain HTTP*. Codeome listens on the Mac's tailnet address. No extra command is needed, but the page is plain HTTP, so the phone cannot install it as an app.
3. Leave **Port** empty to use 47821, or set another.
4. In Serve mode, click **Check Tailscale** under *Tailscale Serve*. It shows whether the Tailscale command-line tool was found, the Mac's MagicDNS name and the command to run. With the default port it is:

   ```
   tailscale serve --bg --https=443 http://127.0.0.1:47821
   ```

   **Copy** puts it on the clipboard. Run it yourself in Terminal; Codeome never runs it. Codeome looks for `tailscale` on the PATH and in `/Applications/Tailscale.app`.
5. Keep **Tailscale Funnel off**. Funnel would publish the page on the public internet. If Codeome sees Funnel enabled, *Check Tailscale* shows a warning. Codeome binds only to the loopback or the tailnet address, never to the public internet.

The status line shows whether the server is listening, and the error if not (for example, no tailnet address in Tailnet mode, or a port already in use).

## Pair a phone

1. Click **Pair a phone**. Codeome shows a QR code, the pairing link and a countdown.
2. Scan the code with the phone camera, or open the link on the phone.
3. The page pairs and opens. The code works once and expires after 5 minutes. It sits in the part of the link after `#`, which the phone's browser does not send to the server in a request.

Pairing gives the phone a long-lived token, kept in the browser's local storage. The Mac keeps only a hash of it. The phone is named "Phone" followed by its browser's user-agent text; rename it in *Paired phones*.

### Add the page to the home screen

In Serve mode (HTTPS), use the browser's share menu and choose *Add to Home Screen*. The page then opens like an app. In Tailnet mode this is not available.

## Paired phones and revoking

*Paired phones* lists each device with the dates it was paired and last seen, and a dot showing whether it is connected. **Rename** changes its name. **Revoke** disconnects it at once; it needs a new pairing code to come back. A revoked or unpaired phone shows "This phone was unpaired or revoked" and asks for a new QR code.

## What the phone may approve

Each decision card on the phone shows the tool and its full input. For questions the agent asks, the phone offers the options and an "Other answer" field and a *Submit answers* button. For tool requests, *Allow once* and *Deny*. Deny always works.

*Allow once* is available only for:

- `Read`, `Glob`, `Grep` and `LS`;
- `Write`, `Edit`, `MultiEdit` and `NotebookEdit` on files inside the chat's project;
- `Bash` commands that start with an entry of the allow list, contain none of the characters `; | & $ ( ) < > `` ' " \` or control characters, and do not reach outside the project (no `..`, no paths or `~` outside it). Some options are refused even for allowed commands, such as `find -exec`, `rg --pre`, `date -s` and `git --output`;
- questions from the agent (`AskUserQuestion`).

Everything else shows "This action needs the desktop. You can still deny it here." and must be allowed on the Mac. That includes any other tool, anything that touches a path outside the project, input longer than 8 KB, input that was truncated, and input in which Codeome redacted something that looks like a secret.

There is no "always allow" on the phone.

### Edit the rules

Under **Phone approvals**:

- **Phone Bash allow list**: one command prefix per line. A command matches when it starts with the entry's words. Defaults: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `git status`, `git diff`, `git log`, `git show`, `git branch`, `npm test`, `npm run test`, `node --test`, `pytest`, `grep`, `rg`, `find`, `which`, `date`. Entries are lowercase words, digits, spaces and hyphens.
- **Require desktop for**: JSON rules that send a request to the Mac even when it would otherwise pass. A rule is an object with any of `tool`, `role` (the agent role), `outsideProject` (`true`) and `pattern` (a regular expression tested against the tool input as JSON); a request matching all the keys of a rule needs the Mac. The defaults refuse `rm -rf`, `sudo`, `curl`/`wget` piped to a shell, `git push`, `ssh`, `Write` and `Edit` outside the project, and the `hpc-operator` role.

An invalid rule or allow list (not valid JSON in the box, wrong types, an invalid regular expression) means every request needs the Mac, and the status line shows the error. **Reset to defaults** restores both lists.

Messages from the phone are refused while the chat is in bypass-permissions, auto or accept-edits mode; send them from the Mac.

## ntfy notifications

Codeome can tell your phone when a decision is waiting, through [ntfy](https://ntfy.sh).

1. Under **ntfy notifications**, tick *Send decision notifications*.
2. Click **Reveal topic** and subscribe to the URL it shows in the ntfy app on the phone. The default server is `https://ntfy.sh`, and the topic is a random secret that Codeome generates and keeps with Codeome's other stored secrets. Anyone who knows the topic can read your notifications, so do not share it. **Hide topic** hides it again; **Regenerate topic** makes a new one (the phone must resubscribe); **Send test notification** checks the setup.
3. The notification says "`<project>` needs a decision", or "N decisions are waiting", and opens the companion's address when tapped. It carries the project's folder name and nothing else from the chat. A public server such as ntfy.sh sees that text.

Notifications for one chat are sent at most every 30 seconds, and a burst is merged into one. *Notify only when away from the phone* (on by default) skips them while a paired phone has been connected in the last two minutes.

To use your own ntfy server, set **Server URL**. Addresses that are local or private (`localhost`, `.local`, `10.x`, `192.168.x`, `172.16-31.x`, `100.100.100.200`, link-local, and the IPv6 equivalents) are refused until you tick *Allow private or self-hosted server*. The URL must be http or https with no user name, query or fragment.

## What the Mac must keep doing

The phone can only reach Codeome while the Mac is running it and on the network:

- Keep the Mac awake: leave **Settings → Chat → Keep Mac awake** on (the default). It blocks idle sleep while an agent turn runs, including while it waits for a decision. It does not hold the Mac awake between turns.
- Keep it plugged in. A Mac on battery sleeps sooner and may not wake for the phone.
- Keep the lid open, or use clamshell mode with power and a display attached. Closing the lid otherwise sleeps the Mac whatever the setting.
- Keep Codeome open, Tailscale connected, and the Mac online.

## Threat model

- **Reach**: the page is served only on the loopback address (behind Tailscale Serve) or the Mac's tailnet address. Only devices on your tailnet can open it, and each still needs a paired token. Keep Funnel off. Repeated wrong tokens or codes are rate-limited.
- **A leaked QR code** can be used once, within 5 minutes, by someone on your tailnet, and is replaced when you create a new one. Pair in private.
- **A stolen or lost phone** holds a valid token until you revoke it. With it, someone could read the logs of your chats, send messages to them, stop them, and approve the low-risk actions above. Revoke it in *Paired phones* and, if you used ntfy, regenerate the topic.
- **What is shown**: Codeome redacts values that look like tokens and keys before sending a log or tool input to the phone, and refuses to allow a request whose input was redacted. Redaction is best effort and can miss a secret. Tool input and results can contain secrets that the agent read, and command output can hold more than you expect. Treat the phone like the Mac.
- **Secrets**: the values in *Settings → Secrets* are never sent to the phone, but an agent that uses one can print it into a log.
- Allowing a "safe" command still runs it on your Mac. Remove entries from the allow list you do not want a phone to approve.
