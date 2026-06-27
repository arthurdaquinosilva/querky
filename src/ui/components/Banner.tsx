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


const WORDMARK_COLOR = '#d75f87';

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
              <Text key={x} color={WORDMARK_COLOR} bold>
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
