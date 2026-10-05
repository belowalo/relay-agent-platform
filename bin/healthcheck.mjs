try {
  const response = await fetch('http://127.0.0.1:4311/health/ready', {
    signal: AbortSignal.timeout(2500),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
