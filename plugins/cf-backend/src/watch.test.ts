import { Entity } from '@backstage/catalog-model';
import { getPipelineSnapshot, formatPipelineSnapshot } from './watch';

function vmEntity(annotations: Record<string, string>): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name: 'demo', annotations },
    spec: { type: 'vm', owner: 'group:default/alpha' },
  };
}

describe('VM pipeline status', () => {
  it('reads every recorded workflow process', () => {
    const snapshot = getPipelineSnapshot(
      vmEntity({
        'cf/status': 'frying',
        'cf/processes': JSON.stringify({
          validate: 'success',
          register: 'success',
          provision: 'success',
          'fry-baseline': 'running',
          'fry-software': 'pending',
          'fry-ad-join': 'skipped',
          'fry-access': 'pending',
          finalize: 'pending',
          'on-failure': 'pending',
        }),
      }),
    );

    expect(Object.keys(snapshot.processes)).toHaveLength(9);
    expect(snapshot.processes['fry-baseline']).toBe('running');
    expect(snapshot.processes['fry-ad-join']).toBe('skipped');
    expect(formatPipelineSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        'Validate request: completed',
        'Fry: baseline: in progress',
        'Fry: AD join: skipped',
      ]),
    );
  });

  it('derives the new process view for legacy inventory entries', () => {
    const snapshot = getPipelineSnapshot(
      vmEntity({
        'cf/status': 'ready',
        'cf/stages': JSON.stringify({
          provision: 'success',
          baseline: 'success',
          software: 'skipped',
          'ad-join': 'skipped',
          access: 'success',
        }),
      }),
    );

    expect(snapshot.processes).toEqual({
      validate: 'success',
      register: 'success',
      provision: 'success',
      'fry-baseline': 'success',
      'fry-software': 'skipped',
      'fry-ad-join': 'skipped',
      'fry-access': 'success',
      finalize: 'success',
      'on-failure': 'skipped',
    });
  });

  it('ignores malformed or unknown statuses', () => {
    const snapshot = getPipelineSnapshot(
      vmEntity({
        'cf/status': 'frying',
        'cf/processes': '{not-json}',
      }),
    );

    expect(snapshot.processes.provision).toBe('pending');
    expect(snapshot.processes.finalize).toBe('pending');
  });
});
