import { useState, useEffect } from 'react';
import { parseArgs } from 'node:util';
import { render, Box, Text } from 'ink';
import { connectDsn, connectParams, type ConnectionState } from './db/client.js';
import { App } from './ui/components/App.js';
import { ConnectionWizard } from './ui/components/ConnectionWizard.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    connection: { type: 'string', short: 'c' },
    'ai-url':   { type: 'string', default: 'http://localhost:11434/v1' },
    'ai-model': { type: 'string', default: 'llama3.2' },
    'api-key':  { type: 'string', default: '' },
  },
  strict: false,
});

const initialDsn = values.connection as string | undefined;
const aiUrl = values['ai-url'] as string;
const aiModel = values['ai-model'] as string;
const aiKey = (values['api-key'] as string) || process.env.Q_CLI_API_KEY || '';

interface RootProps {
  initialDsn?: string;
  aiUrl: string;
  aiModel: string;
  aiKey: string;
}

function Root({ initialDsn, aiUrl, aiModel, aiKey }: RootProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
  const [dsnError, setDsnError] = useState<string | null>(null);

  useEffect(() => {
    if (initialDsn) {
      connectDsn(initialDsn).then((state) => {
        if (state.status === 'error') {
          setDsnError(state.message);
        } else {
          setConnectionState(state);
        }
      });
    }
  }, []);

  if (initialDsn && !connectionState && !dsnError) {
    return (
      <Box paddingX={2} paddingTop={1}>
        <Text dimColor>Connecting…</Text>
      </Box>
    );
  }

  if (!connectionState) {
    return <ConnectionWizard onConnect={setConnectionState} initialError={dsnError ?? undefined} />;
  }

  async function handleChangeDatabase(database: string) {
    if (connectionState.status !== 'connected') return;
    const current = connectionState;
    await current.client.end().catch(() => {});
    const next = await connectParams({ ...current.params, database });
    setConnectionState(next);
  }

  return (
    <App
      connectionState={connectionState}
      aiUrl={aiUrl}
      aiModel={aiModel}
      aiKey={aiKey}
      onChangeDatabase={(db) => { void handleChangeDatabase(db); }}
    />
  );
}

const app = render(
  <Root initialDsn={initialDsn} aiUrl={aiUrl} aiModel={aiModel} aiKey={aiKey} />,
  { exitOnCtrlC: false },
);

// An open DB connection would otherwise keep the process alive after the UI unmounts.
void app.waitUntilExit().then(() => process.exit(0));
