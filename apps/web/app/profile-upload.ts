'use client';

import { apiOrigin } from './client';

export type UploadJob = {
  id: string;
  owner: string;
  caption: string;
  file?: File;
  stage: 'queued' | 'uploading' | 'processing' | 'failed' | 'published';
  percent: number;
  error?: string;
  videoId?: string;
};

export function uploadVideo(job: UploadJob, update: (stage: 'uploading' | 'processing', percent: number) => void) {
  return new Promise<string>((resolve, reject) => {
    if (!job.file) { reject(new Error('Choose a video to upload.')); return; }
    const data = new FormData();
    data.append('caption', job.caption);
    data.append('requestId', job.id);
    data.append('owner', job.owner);
    data.append('video', job.file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiOrigin + '/api/videos');
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.timeout = 180000;
    xhr.setRequestHeader('x-mwitu-request', '1');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) update('uploading', Math.min(99, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => update('processing', 100);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && typeof xhr.response?.id === 'string') resolve(xhr.response.id);
      else reject(new Error(typeof xhr.response?.message === 'string' ? xhr.response.message : 'Upload could not finish. Try again.'));
    };
    xhr.onerror = () => reject(new Error('Connection lost. Retry to finish publishing.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long. Retry to check whether it published.'));
    xhr.onabort = () => reject(new Error('Upload interrupted. Try again.'));
    xhr.send(data);
  });
}
