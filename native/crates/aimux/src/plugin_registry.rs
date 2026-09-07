use crate::plugin_api::{NativePlugin, NativePluginApi, NativePluginHost, NativePluginStatus};
use serde_json::Value;

pub struct NativePluginRegistry {
    plugins: Vec<Box<dyn NativePlugin>>,
}

impl NativePluginRegistry {
    pub fn new(plugins: Vec<Box<dyn NativePlugin>>) -> Self {
        Self { plugins }
    }

    pub fn start(&mut self, host: &mut dyn NativePluginHost) -> Vec<NativePluginStatus> {
        self.plugins
            .iter_mut()
            .map(|plugin| {
                let manifest = plugin.manifest();
                let mut api = NativePluginApi::new(&manifest.name, host);
                let result = plugin.start(&mut api);
                NativePluginStatus {
                    source: "builtin".to_owned(),
                    name: manifest.name,
                    status: if result.is_ok() { "loaded" } else { "failed" }.to_owned(),
                    error: result.err(),
                    capabilities: manifest.capabilities,
                }
            })
            .collect()
    }

    pub fn dispatch_event(
        &mut self,
        event: Value,
        host: &mut dyn NativePluginHost,
    ) -> Vec<NativePluginStatus> {
        self.plugins
            .iter_mut()
            .map(|plugin| {
                let manifest = plugin.manifest();
                let mut api = NativePluginApi::new(&manifest.name, host);
                let result = plugin.on_event(event.clone(), &mut api);
                NativePluginStatus {
                    source: "builtin".to_owned(),
                    name: manifest.name,
                    status: if result.is_ok() { "loaded" } else { "failed" }.to_owned(),
                    error: result.err(),
                    capabilities: manifest.capabilities,
                }
            })
            .collect()
    }
}
