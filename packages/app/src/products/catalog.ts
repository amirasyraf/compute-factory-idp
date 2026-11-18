import { Entity } from '@backstage/catalog-model';

export const categories = [
  {
    id: 'compute',
    title: 'Compute',
    description: 'Run workloads on managed compute resources.',
  },
];

export const products = [
  {
    category: 'compute',
    id: 'virtual-machines',
    title: 'Virtual Machines',
    description: 'Launch and manage team-owned servers across platforms.',
    resourceType: 'vm',
    template: 'vm-request',
    launchFlow: 'platform-image',
  },
];

type Product = (typeof products)[number];

export const launchPath = (product: Product) =>
  `/launch/${product.category}/${product.id}`;
export const productPath = (product: Product) =>
  `/products/${product.category}/${product.id}`;

export const virtualMachines = products[0];

export const productOf = (entity: Entity) =>
  products.find(
    product =>
      entity.kind.toLowerCase() === 'resource' &&
      entity.spec?.type === product.resourceType,
  );
