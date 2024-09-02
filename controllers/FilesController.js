import mongodb from 'mongodb';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { contentType } from 'mime-types';
import Bull from 'bull';
import dbClient from '../utils/db.js';
import redisClient from '../utils/redis.js';

const fileQueue = new Bull('fileQueue', { redis: { port: 6379, host: 'localhost' } });

class FilesController {
  static async postUpload(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    let userId = await redisClient.get(token);
    userId = new mongodb.ObjectId(userId);
    const user = await dbClient.usersCollection().findOne({ _id: userId });
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
      name, type, parentId = 0, isPublic = false, data,
    } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing name' });
    }
    const validTypes = ['file', 'image', 'folder'];
    if (!type || !validTypes.includes(type)) {
      res.status(400).json({ error: 'Missing type' });
    }
    if (!data && type !== 'folder') {
      res.status(400).json({ error: 'Missing data' });
    }
    if (parentId !== 0) {
      const parentFile = await dbClient.filesCollection().findOne({ _id: new mongodb.ObjectId(parentId) });
      if (!parentFile) {
        return res.status(400).json({ error: 'Parent not found' });
      }
      if (parentFile.type !== 'folder') {
        return res.status(400).json({ error: 'Parent is not a folder' });
      }
    }
    const fileDocument = {
      userId,
      name,
      type,
      isPublic,
      parentId: parentId !== 0 ? new mongodb.ObjectId(parentId) : 0,
    };
    if (type === 'folder') {
      await dbClient.filesCollection().insertOne(fileDocument);
      const id = fileDocument._id;
      delete fileDocument._id;
      return res.status(201).json({ id, ...fileDocument });
    }
    const folderPath = process.env.FOLDER_PATH || '/tmp/files_manager';
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const localPath = path.join(folderPath, uuidv4());
    fs.writeFileSync(localPath, Buffer.from(data, 'base64'));
    fileDocument.localPath = localPath;
    await dbClient.filesCollection().insertOne(fileDocument);
    if (type === 'image') {
      await fileQueue.add({ fileId: fileDocument._id.toString(), userId: userId.toString() });
    }
    const id = fileDocument._id;
    delete fileDocument._id;
    res.status(201).json({
      id,
      ...fileDocument,
    });
  }

  static async getShow(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = await redisClient.get(token);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { id } = req.params;
    const file = await dbClient.filesCollection().findOne({
      _id: new mongodb.ObjectId(id),
      userId: new mongodb.ObjectId(userId),
    });
    if (!file) {
      return res.status(404).json({ error: 'Not found' });
    }
    delete file._id;
    return res.json({ id, ...file });
  }

  static async getIndex(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = await redisClient.get(token);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { parentId = '0', page = '0' } = req.query;
    const pageSize = 20;
    const pageNumber = parseInt(page, 10);

    const query = {
      userId: new mongodb.ObjectId(userId),
      parentId: parentId === '0' ? 0 : new mongodb.ObjectId(parentId),
    };
    const filesCollection = await dbClient.filesCollection();
    const files = await filesCollection.aggregate([
      { $match: query },
      { $skip: pageNumber * pageSize },
      { $limit: pageSize },
      {
        $project: {
          _id: 0,
          id: '$_id',
          userId: 1,
          name: 1,
          type: 1,
          isPublic: 1,
          parentId: 1,
          localPath: 1,
        },
      },
    ]).toArray();

    return res.status(200).json(files);
  }

  static async putPublish(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = await redisClient.get(token);
    const user = await dbClient.usersCollection().findOne({ _id: new mongodb.ObjectId(userId) });
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { id } = req.params;
    const file = await dbClient.filesCollection().findOneAndUpdate({
      _id: new mongodb.ObjectId(id),
      userId: new mongodb.ObjectId(userId),
    },
    { $set: { isPublic: true } },
    { returnDocument: 'after' });
    if (!file.value) {
      return res.status(404).json({ error: 'Not found' });
    }
    delete file.value._id;
    return res.status(200).send({ id, ...file.value });
  }

  static async putUnpublish(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = await redisClient.get(token);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = await dbClient.usersCollection().findOne({ _id: new mongodb.ObjectId(userId) });
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { id } = req.params;
    const file = await dbClient.filesCollection().findOneAndUpdate({
      _id: new mongodb.ObjectId(id),
      userId: new mongodb.ObjectId(userId),
    },
    { $set: { isPublic: false } },
    { returnDocument: 'after' });
    if (!file.value) {
      return res.status(404).json({ error: 'Not found' });
    }
    delete file.value._id;
    return res.status(200).send({ id, ...file.value });
  }

  static async getFile(req, res) {
    const token = req.headers['x-token'] || req.headers['X-Token'];
    let userId = null;
    if (token) {
      userId = await redisClient.get(token);
    }

    const fileId = req.params.id;
    if (!mongodb.ObjectId.isValid(fileId)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    const file = await dbClient.filesCollection().findOne({ _id: new mongodb.ObjectId(fileId) });
    if (!file || (!file.isPublic && file.userId.toString() !== userId)) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (file.type === 'folder') {
      return res.status(400).json({ error: "A folder doesn't have content" });
    }
    const { size } = req.query;
    if (file.type === 'image' && size && ['500', '250', '100'].includes(size)) {
      const thumbnailPath = `${file.localPath}_${size}`;
      if (!fs.existsSync(thumbnailPath)) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.setHeader('Content-Type', contentType(file.name));
      res.sendFile(path.resolve(thumbnailPath));
    }
    if (file.type === 'image' && size && !['500', '250', '100'].includes(size)) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!fs.existsSync(file.localPath)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('Content-Type', contentType(file.name));
    res.sendFile(path.resolve(file.localPath));
  }
}

export default FilesController;
