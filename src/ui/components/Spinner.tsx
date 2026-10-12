import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export function Spinner({ label }: { label: string }) {
  const [tick, setTick] = useState(0);
  const [start] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - start) / 1000);
  return (
    <Text>
      <Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text color={theme.accent}>{label}…</Text>
      <Text color={theme.muted}> ({secs}s · ctrl+c to exit)</Text>
    </Text>
  );
}
