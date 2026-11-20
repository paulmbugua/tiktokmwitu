'use client';

import { apiOrigin } from './client';

export type UploadJob = {
  id: string;
  owner: string;
  caption: string;
  file?: File;
  photos?: File[];
  imageIds?: string[];
  stage: 'queued' | 'uploading' | 'processing' | 'failed' | 'published';
  percent: number;
  error?: string;
  videoId?: string;
};

export function uploadVideo(job: UploadJob, update: (stage: 'uploading' | 'processing', percent: number) => void) {
  return new Promise<{ id: string; image_ids?: string[] }>((resolve, reject) => {
    if (!job.file && !job.photos?.length) { reject(new Error('Choose media to upload.')); return; }
    const data = new FormData();
    data.append('caption', job.caption);
    data.append('requestId', job.id);
    data.append('owner', job.owner);
    if (job.file) data.append('video', job.file);
    else for (const photo of job.photos ?? []) data.append('photos', photo);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiOrigin + (job.file ? '/api/videos' : '/api/photo-posts'));
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.timeout = 180000;
    xhr.setRequestHeader('x-mwitu-request', '1');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) update('uploading', Math.min(99, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => update('processing', 100);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && typeof xhr.response?.id === 'string') resolve(xhr.response);
      else reject(new Error(typeof xhr.response?.message === 'string' ? xhr.response.message : 'Upload could not finish. Try again.'));
    };
    xhr.onerror = () => reject(new Error('Connection lost. Retry to finish publishing.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long. Retry to check whether it published.'));
    xhr.onabort = () => reject(new Error('Upload interrupted. Try again.'));
    xhr.send(data);
  });
}
