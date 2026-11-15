function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '—';
}

function entries(value: unknown): string {
  const pairs = Object.entries(object(value)).filter(
    ([, item]) => typeof item === 'string',
  );
  return pairs.map(([key, item]) => `${key}: ${item}`).join(', ') || 'none';
}

// Desired values come exclusively from spec; annotations are observed state/provenance.
export function getVmConfiguration(value: unknown) {
  const spec = object(value);
  const compute = object(spec.compute);
  const configuration = object(spec.configuration);
  const software = Array.isArray(configuration.software)
    ? configuration.software.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  return {
    team: text(spec.owner).split('/').pop() ?? '—',
    platform: text(compute.platform),
    os: text(compute.os),
    size: text(compute.size),
    software: software.join(', ') || 'none',
    adJoin:
      configuration.adJoin === true ? 'Requested (mock)' : 'Not requested',
    billing: entries(spec.billing),
    cloudTags: entries(spec.cloudTags),
  };
}
