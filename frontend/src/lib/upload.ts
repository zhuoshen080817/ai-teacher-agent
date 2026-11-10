const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080'

export interface UploadProgress {
  loaded: number
  total: number
}

interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void
}

interface ErrorPayload {
  detail?: string
}

/**
 * 使用 XMLHttpRequest 上传 FormData：
 * - 支持真实上传进度（fetch 无法获取 upload progress）
 * - timeout = 0，大文件上传不设超时
 */
export function uploadFormData<T>(
  path: string,
  formData: FormData,
  options: UploadOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE_URL}${path}`)
    xhr.timeout = 0
    xhr.responseType = 'text'

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.({ loaded: event.loaded, total: event.total })
    }

    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = null
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T)
        return
      }

      const detail =
        data && typeof data === 'object' && 'detail' in data
          ? (data as ErrorPayload).detail
          : undefined
      reject(new Error(detail || `HTTP ${xhr.status}`))
    }

    xhr.onerror = () => reject(new Error('网络异常，上传失败，请检查后端是否在运行'))
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'))
    xhr.onabort = () => reject(new Error('上传已取消'))

    xhr.send(formData)
  })
}
