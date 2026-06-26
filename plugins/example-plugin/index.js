// Example plugin — a template for writing your own.
//
// To use: put this folder at AIROUTER_HOME/plugins/<name>/ (user plugins) or
// ship it under ./plugins/<name>/ (bundled), then add its folder name to
// config.plugins.enabled. Each plugin exports register(api).
export function register(api) {
  // 1) Register a tool the model can call.
  api.registerTool(
    {
      name: "ping_example",
      description: "Example plugin tool — returns pong.",
      input_schema: { type: "object", properties: {} },
    },
    async (_input, _ctx) => ({ success: true, message: "pong" })
  );

  // 2) Register a bash-command reviewer. Return null = no opinion (fall through
  //    to the core policy); { approved: false, reason } = block; { approved: true } = allow.
  api.registerCommandReviewer((command) => {
    if (/example-forbidden-token/i.test(command)) {
      return { approved: false, reason: "blocked by example-plugin", reviewer: "example-plugin" };
    }
    return null;
  });

  // api.config, api.log, api.pluginConfig(name), api.isDangerousCommand are also available.
  api.log("example-plugin loaded");
}
