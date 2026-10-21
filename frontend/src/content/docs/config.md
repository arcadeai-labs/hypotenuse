# Config file

The daemon reads one TOML file, `~/.config/hypotenuse/config.toml`. `hypotenuse config init` writes a starter,
`hypotenuse config validate` checks it, and `hypotenuse config schema` prints its JSON Schema, which editors with
TOML support use for completion through the file's first line. [The daemon](/docs/daemon) explains how to use it;
this page is every key.
