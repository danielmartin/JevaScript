use zed_extension_api::{self as zed, settings::LspSettings, Result};

struct JevaScript;

impl zed::Extension for JevaScript {
    fn new() -> Self { Self }

    fn language_server_command(
        &mut self,
        _id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if let Some(binary) = LspSettings::for_worktree("jevascript", worktree)?.binary {
            if let Some(command) = binary.path {
                return Ok(zed::Command { command,
                    args: binary.arguments.unwrap_or_else(|| vec!["--stdio".into()]),
                    env: binary.env.unwrap_or_default().into_iter().collect() });
            }
        }
        // Local packaging writes the checkout path; no server or model runs in the editor.
        let server = include_str!("../local-server.txt").trim();
        Ok(zed::Command { command: zed::node_binary_path()?,
            args: vec![server.into(), "--stdio".into()], env: Default::default() })
    }
}

zed::register_extension!(JevaScript);
