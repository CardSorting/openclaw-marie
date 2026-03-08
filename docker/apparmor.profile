# AppArmor profile for OpenClaw-Marie
# This profile provides kernel-level mandatory access control for the Marie container.

#include <tunables/global>

profile marie-agent flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/node>

  # Network restrictions: allow LAN/WAN for API calls but block local sensitive ports
  network inet stream,
  network inet6 stream,

  # Deny access to sensitive host filesystems
  deny /etc/shadow r,
  deny /etc/gshadow r,
  deny /root/** rw,
  deny /var/run/docker.sock rw,

  # Allow read access to node modules and app source
  /home/node/openclaw/** r,
  /home/node/openclaw/src/** r,
  /home/node/openclaw/node_modules/** r,

  # Allow read/write access to state and workspace (restricted to openclaw home)
  /home/node/.openclaw/** rw,
  /home/node/.npm/** rw,
  /tmp/** rw,

  # Explicitly allow bash and common tools (limited by Command Blocklist at app layer)
  /usr/bin/node ix,
  /bin/bash ix,
  /bin/sh ix,
  /usr/bin/git ix,
  /usr/bin/ssh ix,

  # Block dangerous tools at the kernel level as well
  deny /usr/bin/nc* x,
  deny /usr/bin/netcat* x,
  deny /usr/bin/curl* x,
  deny /usr/bin/wget* x,
  deny /usr/bin/docker* x,
}
