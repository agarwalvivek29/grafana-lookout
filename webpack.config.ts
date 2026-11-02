import type { Configuration } from 'webpack';
import { merge } from 'webpack-merge';
import grafanaConfig, { type Env } from './.config/webpack/webpack.config';

// Extends the create-plugin config: Grafana shares 'react-dom/client' with plugins, so mark it external
// to avoid bundling a second React DOM (needed for the floating assistant panel's own root).
const config = async (env: Env): Promise<Configuration> => {
  const base = await grafanaConfig(env);
  const externals = Array.isArray(base.externals) ? base.externals : [base.externals];
  return merge({ ...base, externals: [] }, { externals: [...externals, 'react-dom/client'] as Configuration['externals'] });
};

export default config;
