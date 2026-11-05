# Discord channel policy parser

The Discord installation resolver and installation-scoped preview share a strict parser for channel lists and audience maps. Invalid JSON, malformed entries and duplicate decoded channel keys fail closed. A missing audience map defaults to public; a valid channel-less headless preview uses public audience. The Discord handler still requires its actual channel to pass the installation allowlist.

This change does not fence policy changes between preview, draw, recovery and external Discord delivery. It does not establish current media-byte authorization or qualify deployment. A malformed installation requires an administrator to repair its configuration through an authorized management route.
