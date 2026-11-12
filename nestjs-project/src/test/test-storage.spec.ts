import { assertTestBucket, TestStorageGuardError } from './test-storage';

describe('assertTestBucket', () => {
  it.each(['streamtube-videos', 'videos-test-data', 'Bucket-test', ''])(
    'should refuse the non-test bucket "%s"',
    (bucket) => {
      expect(() => assertTestBucket(bucket)).toThrow(TestStorageGuardError);
    },
  );

  it('should accept a bucket ending with -test', () => {
    expect(() => assertTestBucket('streamtube-videos-test')).not.toThrow();
  });
});
