import { Box, Text } from 'ink';
import type { ConnectionState } from '../../db/client.js';
import { theme } from '../theme.js';

declare const __PKG_VERSION__: string;
const version = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : (process.env.npm_package_version ?? 'unknown');

const WORDMARK = [
  '▗▄▄▄▖ ▗▖ ▗▖▗▄▄▄▖▗▄▄▖ ▗▖ ▗▖▗▖  ▗▖',
  '▐▌ ▐▌ ▐▌ ▐▌▐▌   ▐▌ ▐▌▐▌▗▞▘ ▝▚▞▘',
  '▐▌ ▐▌ ▐▌ ▐▌▐▛▀▀▘▐▛▀▚▖▐▛▚▖   ▐▌',
  '▐▙▄▟▙▖▝▚▄▞▘▐▙▄▄▖▐▌ ▐▌▐▌ ▐▌  ▐▌ ▄▄▄',
];

const WORDMARK_WIDTH = Math.max(...WORDMARK.map((l) => [...l].length));

const GRADIENT = [
  '#af87af',  // habamax Statement — muted purple
  '#87afaf',  // habamax Identifier — muted teal
  '#5faf5f',  // habamax String — muted green
];

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function gradientColor(t: number): string {
  const seg = Math.max(0, Math.min(1, t)) * (GRADIENT.length - 1);
  const i = Math.min(Math.floor(seg), GRADIENT.length - 2);
  const f = seg - i;
  const [r1, g1, b1] = hexToRgb(GRADIENT[i]);
  const [r2, g2, b2] = hexToRgb(GRADIENT[i + 1]);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f).toString(16).padStart(2, '0');
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`;
}

interface BannerProps {
  connectionState: ConnectionState;
}

export function Banner({ connectionState }: BannerProps) {
  const isConnected = connectionState.status === 'connected';

  return (
    <Box flexDirection="column" marginTop={2} marginBottom={1}>
      {/* Wordmark — horizontal magenta→orange gradient, with trailing cursor */}
      <Box flexDirection="column">
        {WORDMARK.map((line, li) => (
          <Box key={li}>
            {[...line].map((ch, x) => (
              <Text key={x} color={gradientColor(WORDMARK_WIDTH > 1 ? x / (WORDMARK_WIDTH - 1) : 0)} bold>
                {ch}
              </Text>
            ))}
          </Box>
        ))}
      </Box>

      {/* Info — stacked below */}
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text dimColor>v{version}</Text>
        <Text> </Text>
        {isConnected ? (
          <>
            <Text>
              <Text dimColor>Connected as  </Text>
              <Text bold color={theme.insertMode}>{connectionState.user}</Text>
            </Text>
            <Text>
              <Text dimColor>Database      </Text>
              <Text bold color={theme.insertMode}>{connectionState.database}</Text>
            </Text>
            <Text>
              <Text dimColor>Host          </Text>
              <Text bold color={theme.insertMode}>{connectionState.host}</Text>
            </Text>
          </>
        ) : (
          <Text color={theme.error}>✗ {connectionState.message}</Text>
        )}
      </Box>
    </Box>
  );
}
