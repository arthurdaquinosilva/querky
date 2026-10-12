import { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { connectParams, type ConnectionState, type Driver } from '../../db/client.js';
import { getPassword } from '../../config/keychain.js';
import { theme } from '../theme.js';

const DRIVERS: Driver[] = ['postgresql', 'mysql', 'sqlite'];
const LABEL_WIDTH = 10;

interface WizardFields {
  driver: Driver;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

interface ConnectionWizardProps {
  onConnect: (state: ConnectionState) => void;
  initialError?: string;
}

function fieldLabels(driver: Driver): string[] {
  if (driver === 'sqlite') return ['Driver', 'File path'];
  return ['Driver', 'Host', 'Port', 'Database', 'User', 'Password'];
}

export function ConnectionWizard({ onConnect, initialError }: ConnectionWizardProps) {
  const { isRawModeSupported } = useStdin();
  const [focus, setFocus] = useState(0);
  const [fields, setFields] = useState<WizardFields>({
    driver: 'postgresql',
    host: 'localhost',
    port: '5432',
    database: '',
    user: '',
    password: '',
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [keychainHint, setKeychainHint] = useState(false);

  const labels = fieldLabels(fields.driver);
  const fieldCount = labels.length;

  function getTextValue(idx: number): string {
    if (fields.driver === 'sqlite') {
      return idx === 1 ? fields.database : '';
    }
    switch (idx) {
      case 1: return fields.host;
      case 2: return fields.port;
      case 3: return fields.database;
      case 4: return fields.user;
      case 5: return fields.password;
      default: return '';
    }
  }

  function setTextValue(idx: number, value: string) {
    setFields((prev) => {
      if (prev.driver === 'sqlite') {
        return idx === 1 ? { ...prev, database: value } : prev;
      }
      switch (idx) {
        case 1: return { ...prev, host: value };
        case 2: return { ...prev, port: value };
        case 3: return { ...prev, database: value };
        case 4: return { ...prev, user: value };
        case 5: return { ...prev, password: value };
        default: return prev;
      }
    });
  }

  function cycleDriver(dir: 1 | -1) {
    setFields((prev) => {
      const idx = DRIVERS.indexOf(prev.driver);
      const next = DRIVERS[(idx + dir + DRIVERS.length) % DRIVERS.length];
      const port = next === 'mysql' ? '3306' : next === 'postgresql' ? '5432' : '0';
      return { ...prev, driver: next, port };
    });
    setFocus(0);
  }

  function moveFocus(next: number) {
    setFocus(next);
    if (fields.driver !== 'sqlite' && next === 5 && !fields.password) {
      void getPassword(
        fields.driver,
        fields.user,
        fields.host,
        parseInt(fields.port) || (fields.driver === 'mysql' ? 3306 : 5432),
      ).then((saved) => {
        if (saved) {
          setFields((prev) => ({ ...prev, password: saved }));
          setKeychainHint(true);
        }
      });
    } else {
      setKeychainHint(false);
    }
  }

  async function submit() {
    setConnecting(true);
    setError(null);
    setKeychainHint(false);
    const result = await connectParams({
      driver: fields.driver,
      host: fields.host || 'localhost',
      port: parseInt(fields.port) || (fields.driver === 'mysql' ? 3306 : 5432),
      database: fields.database,
      user: fields.user,
      password: fields.password,
    });
    setConnecting(false);
    if (result.status === 'error') {
      setError(result.message);
    } else {
      onConnect(result);
    }
  }

  useInput(
    (input, key) => {
      if (connecting) return;

      if (key.tab && key.shift) { moveFocus((focus - 1 + fieldCount) % fieldCount); return; }
      if (key.tab || key.downArrow) { moveFocus((focus + 1) % fieldCount); return; }
      if (key.upArrow) { moveFocus((focus - 1 + fieldCount) % fieldCount); return; }

      if (focus === 0) {
        if (key.leftArrow) cycleDriver(-1);
        if (key.rightArrow || input === ' ') cycleDriver(1);
        if (key.return) moveFocus(1);
        return;
      }

      if (key.return) {
        if (focus === fieldCount - 1) { void submit(); }
        else { moveFocus(focus + 1); }
        return;
      }

      if (key.backspace || key.delete) {
        setKeychainHint(false);
        setTextValue(focus, getTextValue(focus).slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        if (keychainHint) {
          setKeychainHint(false);
          setTextValue(focus, input);
        } else {
          setTextValue(focus, getTextValue(focus) + input);
        }
      }
    },
    { isActive: isRawModeSupported },
  );

  const isPassword = (idx: number) => fields.driver !== 'sqlite' && idx === 5;

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={2} paddingBottom={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>Connect to a database</Text>
      </Box>

      {labels.map((label, idx) => {
        const isFocused = focus === idx;
        const isDriver = idx === 0;

        return (
          <Box key={label}>
            <Text color={isFocused ? theme.accent : undefined} bold={isFocused}>
              {label.padEnd(LABEL_WIDTH)}
            </Text>
            {isDriver ? (
              <Box>
                {DRIVERS.map((d, i) => (
                  <Box key={d}>
                    {i > 0 && <Text>{'   '}</Text>}
                    <Text color={fields.driver === d ? theme.accent : undefined} bold={fields.driver === d}>
                      {fields.driver === d ? '● ' : '○ '}{d.charAt(0).toUpperCase() + d.slice(1)}
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : (
              <Box>
                <Text>
                  {isPassword(idx) ? '•'.repeat(getTextValue(idx).length) : getTextValue(idx)}
                </Text>
                {isFocused && <Text color={theme.accent} bold>▌</Text>}
                {isFocused && isPassword(idx) && keychainHint && (
                  <Text dimColor>  (from keychain)</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}

      {fields.driver === 'sqlite' && (
        <Text dimColor>
          {' '.repeat(LABEL_WIDTH)}~/ and absolute paths work; relative paths start at {process.cwd()}
        </Text>
      )}

      <Box marginTop={1}>
        {connecting ? (
          <Text dimColor>Connecting…</Text>
        ) : error ? (
          <Text color={theme.error}>✗ {error}</Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Tab · ↑↓ navigate   Enter connect   ←→ cycle driver</Text>
      </Box>
    </Box>
  );
}
