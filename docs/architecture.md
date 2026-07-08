# Architecture Notes

## Hooks

This plugin registers exactly two hooks:

| Hook | Behavior |
| --- | --- |
| `config` | No-op. Present so the plugin factory conforms to the plugin `Hooks` contract; makes no config changes. |
| `tool` | Registers the four read-only session tools (`session_list`, `session_info`, `session_read`, `session_search`). |

See [`README.md`](../README.md) for the tool argument reference and [`AGENTS.md`](../AGENTS.md)
for the read-only contract this plugin must preserve.
