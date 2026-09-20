// s3store.js - 团队云 S3 对象存储层
// 通过环境变量配置: TEAMCLOUD_S3_ENDPOINT / TEAMCLOUD_S3_ACCESS_KEY / TEAMCLOUD_S3_SECRET_KEY / TEAMCLOUD_S3_BUCKET
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');

const endpoint = process.env.TEAMCLOUD_S3_ENDPOINT || 'https://cn-nb1.rains3.com';
const accessKey = process.env.TEAMCLOUD_S3_ACCESS_KEY;
const secretKey = process.env.TEAMCLOUD_S3_SECRET_KEY;
const bucket = process.env.TEAMCLOUD_S3_BUCKET || 'teamcloud';

if (!accessKey || !secretKey) {
  console.error('[S3] 缺少 TEAMCLOUD_S3_ACCESS_KEY / TEAMCLOUD_S3_SECRET_KEY 环境变量');
}

const s3 = new S3Client({
  endpoint,
  region: 'auto',
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// key 前缀与桶内历史数据一致: wwwuser/...
function userKey(userId, storedName) { return `wwwuser/user_${userId}/${storedName}`; }
function sharedKey(storedName) { return `wwwuser/shared/${storedName}`; }
function teamKey(teamId, storedName) { return `wwwuser/teams/team_${teamId}/${storedName}`; }

// 根据文件记录解析 S3 key
function resolveKey(file) {
  if (file.team_id) return teamKey(file.team_id, file.stored_name);
  return userKey(file.user_id, file.stored_name);
}

// 上传本地文件到 S3
async function putFile(key, localPath) {
  const body = fs.createReadStream(localPath);
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  } finally {
    body.destroy();
  }
}

// 检查对象是否存在,返回 { exists, size } 
async function headObject(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: Number(r.ContentLength || 0) };
  } catch (e) {
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return { exists: false, size: 0 };
    }
    throw e;
  }
}

// 获取对象流,支持 Range(透传给 S3,返回 S3 的 ContentRange/ContentLength)
// 返回 { stream, size, contentLength, contentRange } 或 { notFound: true }
async function getObject(key, range) {
  const params = { Bucket: bucket, Key: key };
  if (range) params.Range = range;
  try {
    const r = await s3.send(new GetObjectCommand(params));
    return {
      stream: r.Body,
      size: Number(r.ContentLength || 0),
      contentLength: r.ContentLength != null ? Number(r.ContentLength) : null,
      contentRange: r.ContentRange || null,
    };
  } catch (e) {
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return { notFound: true };
    }
    if (e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416) {
      return { invalidRange: true };
    }
    throw e;
  }
}

// 删除单个对象
async function deleteObject(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404) return; // 不存在也算成功
    throw e;
  }
}

// 批量删除(按前缀列出并删除),用于解散团队
// 注: Rains3 对批量 DeleteObjects 强制要求 Content-MD5,改用单条并发删除,简单可靠
async function deleteByPrefix(prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  let keys = [];
  let continuation = undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuation,
    }));
    for (const obj of r.Contents || []) keys.push(obj.Key);
    continuation = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (continuation);
  const CHUNK = 20;
  for (let i = 0; i < keys.length; i += CHUNK) {
    await Promise.all(keys.slice(i, i + CHUNK).map(k => deleteObject(k)));
  }
  return keys.length;
}

// 生成预签名 PUT URL（浏览器直传）
async function presignPut(key, contentType, expiresIn = 3600) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType || undefined }), { expiresIn });
}

// 生成预签名 GET URL（浏览器直下）；filename 为空=内联预览；contentType 可强制覆盖响应类型
async function presignGet(key, filename, expiresIn = 600, contentType) {
  const params = { Bucket: bucket, Key: key };
  if (filename) {
    // 让 S3 直接返回带原始文件名的 Content-Disposition
    params.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  if (contentType) params.ResponseContentType = contentType;
  return getSignedUrl(s3, new GetObjectCommand(params), { expiresIn });
}

// 服务端侧复制对象（同桶内），用于「复制到 / 复制文件夹」等场景
async function copyObject(srcKey, dstKey) {
  const encoded = srcKey.split('/').map(encodeURIComponent).join('/');
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: dstKey,
    CopySource: `/${bucket}/${encoded}`,
    MetadataDirective: 'COPY'
  }));
}

module.exports = { s3, bucket, endpoint, userKey, sharedKey, teamKey, resolveKey, putFile, headObject, getObject, deleteObject, deleteByPrefix, presignPut, presignGet, copyObject };
