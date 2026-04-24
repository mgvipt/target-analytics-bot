import axios from 'axios';

const BASE_URL = 'https://graph.facebook.com';

export function createMetaClient(config) {
  const { accessToken, apiVersion = 'v21.0', adAccountId, pageId, igAccountId } = config;

  const client = axios.create({
    baseURL: `${BASE_URL}/${apiVersion}`,
    params: { access_token: accessToken },
  });

  async function get(path, params = {}) {
    const res = await client.get(path, { params });
    return res.data;
  }

  async function post(path, data = {}) {
    const res = await client.post(path, null, { params: data });
    return res.data;
  }

  async function postForm(path, formData) {
    const res = await client.post(path, formData, {
      params: { access_token: accessToken },
      headers: formData.getHeaders ? formData.getHeaders() : {},
    });
    return res.data;
  }

  async function del(path) {
    const res = await client.delete(path);
    return res.data;
  }

  return { get, post, postForm, del, adAccountId, pageId, igAccountId, accessToken, apiVersion };
}
