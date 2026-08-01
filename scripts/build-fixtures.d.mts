// The fixture generator is plain JavaScript so it can run before anything is
// built. This declares only what the test suite reads from it.
export declare const generatedDir: string;
export declare const pmtilesFixture: string;
export declare const mbtilesFixture: string;
export declare const unlabeledPmtilesFixture: string;
export declare const tileDirectory: string;
export declare const directoryTiles: { z: number; x: number; y: number }[];
export declare function buildBinaryFixtures(): Promise<{
  pmtilesFixture: string;
  mbtilesFixture: string;
  unlabeledPmtilesFixture: string;
  tileDirectory: string;
}>;
