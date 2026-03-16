// services/storageService.js
// S3-compatible storage abstraction. Works with AWS S3 and Cloudflare R2.
// Set S3_ENDPOINT for R2; leave unset for AWS.
//
// ENV: S3_BUCKET, S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//      S3_ENDPOINT (R2 only): https://<accountid>.r2.cloudflarestorage.com

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { storage: log } = require('./logger');
const { Readable }     = require('stream');
const path             = require('path');
const { randomUUID }   = require('crypto');

let _client;
function getClient() {
  if (_client) return _client;
  const cfg = {
    region: process.env.S3_REGION || 'auto',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  };
  if (process.env.S3_ENDPOINT) { cfg.endpoint = process.env.S3_ENDPOINT; cfg.forcePathStyle = true; }
  return (_client = new S3Client(cfg));
}

const BUCKET = () => {
  if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET env var not set');
  return process.env.S3_BUCKET;
};

// Upload a Buffer → returns S3 key
async function uploadBuffer({ buffer, originalName = 'file', folder = 'uploads', contentType = 'application/octet-stream' }) {
  const key = `${folder}/${randomUUID()}${path.extname(originalName).toLowerCase()}`;
  await getClient().send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: buffer, ContentType: contentType }));
  log.info({ key, bytes: buffer.length }, 'Uploaded to storage');
  return key;
}

// Convenience: upload a CSV buffer scoped to a tenant
async function uploadCsv(buffer, tenantId) {
  return uploadBuffer({ buffer, originalName: 'upload.csv', folder: `csv/${tenantId}`, contentType: 'text/csv' });
}

// Download an S3 object as a Buffer
async function downloadBuffer(key) {
  const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    if (!(res.Body instanceof Readable)) return reject(new Error('Unexpected S3 stream type'));
    res.Body.on('data', c => chunks.push(c));
    res.Body.on('end',  () => resolve(Buffer.concat(chunks)));
    res.Body.on('error', reject);
  });
}

// Delete object (cleanup after processing)
async function deleteObject(key) {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
    log.info({ key }, 'Storage object deleted');
  } catch (err) {
    log.warn({ err, key }, 'Delete failed (non-fatal)');
  }
}

// Generate a time-limited presigned download URL
async function presignedDownloadUrl(key, expiresInSeconds = 3600) {
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: expiresInSeconds });
}

module.exports = { uploadBuffer, uploadCsv, downloadBuffer, deleteObject, presignedDownloadUrl };
