// Loads the vendored YAMNet TF.js model from disk in Node (no tfjs-node needed).
import * as tf from '@tensorflow/tfjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function loadYamnetModelFromDisk(modelJsonPath) {
  const json = JSON.parse(await readFile(modelJsonPath, 'utf8'));
  const dir = dirname(modelJsonPath);
  const weightSpecs = json.weightsManifest.flatMap((g) => g.weights);
  const buffers = [];
  for (const g of json.weightsManifest) for (const p of g.paths) buffers.push(await readFile(join(dir, p)));
  const all = Buffer.concat(buffers);
  const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
  return tf.loadGraphModel({
    load: async () => ({ modelTopology: json.modelTopology, weightSpecs, weightData, format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy, userDefinedMetadata: json.userDefinedMetadata }),
  });
}
