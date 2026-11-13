import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import { buildS3Clients, destroyS3Clients } from './s3-clients.provider';

const config = (
  overrides: Partial<ConfigType<typeof storageConfig>> = {},
): ConfigType<typeof storageConfig> => ({
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'streamtube-videos',
  testBucket: 'streamtube-videos-test',
  forcePathStyle: true,
  accessKeyId: 'api-id',
  secretAccessKey: 'api-secret',
  deliveryAccessKeyId: 'delivery-id',
  deliverySecretAccessKey: 'delivery-secret',
  ...overrides,
});

describe('buildS3Clients', () => {
  it('should sign parts with the process identity and delivery URLs with the delivery identity', async () => {
    const clients = buildS3Clients(config());

    const part = await clients.partSigner.config.credentials();
    const delivery = await clients.deliverySigner?.config.credentials();
    const internal = await clients.internal.config.credentials();

    expect(part.accessKeyId).toBe('api-id');
    expect(internal.accessKeyId).toBe('api-id');
    expect(delivery?.accessKeyId).toBe('delivery-id');
    expect(await clients.deliverySigner?.config.endpoint?.()).toMatchObject({
      hostname: 'localhost',
    });
    destroyS3Clients(clients);
  });

  it('should not build a delivery signer without the delivery identity (worker)', () => {
    const clients = buildS3Clients(
      config({
        accessKeyId: 'worker-id',
        deliveryAccessKeyId: '',
        deliverySecretAccessKey: '',
      }),
    );

    expect(clients.deliverySigner).toBeUndefined();
    destroyS3Clients(clients);
  });
});
