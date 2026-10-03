// Private "clips" container with 24-hour read-only SAS links.
const { BlobServiceClient, BlobSASPermissions } = require('@azure/storage-blob');

const CONTAINER = 'clips';
const SAS_HOURS = 24;
let container;

async function getContainer() {
  if (!container) {
    if (!process.env.STORAGE_CONNECTION_STRING) throw new Error('STORAGE_CONNECTION_STRING is not set');
    const svc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
    const c = svc.getContainerClient(CONTAINER);
    await c.createIfNotExists(); // no "access" option means private
    container = c;
  }
  return container;
}

async function uploadClip(name, buffer, contentType) {
  const c = await getContainer();
  const blob = c.getBlockBlobClient(name);
  await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
  const expiresOn = new Date(Date.now() + SAS_HOURS * 3600 * 1000);
  const url = await blob.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn });
  return { url, expiresOn };
}

module.exports = { uploadClip };
