import { mockServices, mockCredentials } from '@backstage/backend-test-utils';
import {
  AuthorizeResult,
  createPermission,
} from '@backstage/plugin-permission-common';
import { permissionRules as catalogPermissionRules } from '@backstage/plugin-catalog-backend/alpha';
import { ComputeFactoryPolicy } from './policy';

const read = createPermission({
  name: 'catalog.entity.read',
  attributes: { action: 'read' },
  resourceType: 'catalog-entity',
});
const user = {
  credentials: mockCredentials.user(),
  info: {
    userEntityRef: 'user:default/alice',
    ownershipEntityRefs: ['user:default/alice'],
  },
};
function policy(groups: string[]) {
  return new ComputeFactoryPolicy(
    mockServices.userInfo({
      ownershipEntityRefs: ['user:default/alice', ...groups],
      userEntityRef: 'user:default/alice',
    }),
  );
}
// Evaluate the actual exported catalog rules, not a duplicate of policy logic.
function apply(criteria: any, entity: any): boolean {
  if (criteria.anyOf) return criteria.anyOf.some((c: any) => apply(c, entity));
  if (criteria.allOf) return criteria.allOf.every((c: any) => apply(c, entity));
  if (criteria.not) return !apply(criteria.not, entity);
  const rule = Object.values(catalogPermissionRules).find(
    r => r.name === criteria.rule,
  )!;
  return rule.apply(entity, criteria.params);
}
const vm = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'demo' },
  spec: { type: 'vm', owner: 'group:default/alpha' },
  relations: [{ type: 'ownedBy', targetRef: 'group:default/alpha' }],
};

it('allows admins everything', async () => {
  expect(
    await policy(['group:default/platform-admins']).handle(
      { permission: read },
      user,
    ),
  ).toEqual({ result: AuthorizeResult.ALLOW });
});
it('allows owning team, hides other team, permits non-VMs', async () => {
  for (const [groups, expected] of [
    [['group:default/alpha'], true],
    [['group:default/bravo'], false],
  ] as const) {
    const decision = await policy([...groups]).handle(
      { permission: read },
      user,
    );
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    if (decision.result !== AuthorizeResult.CONDITIONAL)
      throw new Error('Expected conditional decision');
    expect(apply(decision.conditions, vm)).toBe(expected);
    expect(apply(decision.conditions, { ...vm, kind: 'Component' })).toBe(true);
    expect(
      apply(decision.conditions, { ...vm, spec: { type: 'database' } }),
    ).toBe(true);
  }
});
it.each([
  'catalog.entity.delete',
  'catalog.location.create',
  'catalog.location.delete',
])('denies %s to non-admins', async name => {
  expect(
    await policy(['group:default/alpha']).handle(
      { permission: createPermission({ name, attributes: {} }) },
      user,
    ),
  ).toEqual({ result: AuthorizeResult.DENY });
});
it.each(['scaffolder.task.read', 'scaffolder.task.cancel'])(
  'restricts %s to task initiator',
  async name => {
    const permission = createPermission({
      name,
      attributes: {},
      resourceType: 'scaffolder-task',
    });
    const decision = await policy([]).handle({ permission }, user);
    expect(decision).toMatchObject({
      result: AuthorizeResult.CONDITIONAL,
      conditions: {
        rule: 'IS_TASK_OWNER',
        params: { createdBy: ['user:default/alice'] },
      },
    });
  },
);
