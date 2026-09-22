#include "eclipse/net/http_client.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <cctype>
#include <memory>

namespace eclipse::net {
namespace {

std::size_t write_body(char* ptr, std::size_t size, std::size_t nmemb,
                       void* userdata) {
  auto* out = static_cast<std::string*>(userdata);
  out->append(ptr, size * nmemb);
  return size * nmemb;
}

std::size_t write_header(char* ptr, std::size_t size, std::size_t nmemb,
                         void* userdata) {
  auto* out = static_cast<std::map<std::string, std::string>*>(userdata);
  const std::size_t total = size * nmemb;

  std::string line(ptr, total);
  const auto colon = line.find(':');
  if (colon != std::string::npos) {
    std::string key = line.substr(0, colon);
    std::string value = line.substr(colon + 1);

    const auto trim = [](std::string& s) {
      while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front())))
        s.erase(s.begin());
      while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
        s.pop_back();
    };
    trim(key);
    trim(value);

    std::transform(key.begin(), key.end(), key.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    (*out)[key] = value;
  }
  return total;
}

/// One curl handle per thread. The portfolio tracker and the CLI thread both
/// issue RPC calls, and a handle is not safe to share between them.
CURL* thread_handle() {
  static thread_local std::unique_ptr<CURL, void (*)(CURL*)> handle(
      curl_easy_init(), [](CURL* h) { curl_easy_cleanup(h); });
  return handle.get();
}

}  // namespace

HttpClient::HttpClient() { curl_global_init(CURL_GLOBAL_DEFAULT); }
HttpClient::~HttpClient() { curl_global_cleanup(); }

HttpClient& HttpClient::instance() {
  static HttpClient client;
  return client;
}

HttpResponse HttpClient::send(const HttpRequest& request) {
  HttpResponse response;

  CURL* curl = thread_handle();
  if (curl == nullptr) {
    response.error = "could not initialise curl";
    return response;
  }
  curl_easy_reset(curl);

  curl_slist* headers = nullptr;
  for (const auto& header : request.headers) {
    headers = curl_slist_append(headers, header.c_str());
  }

  curl_easy_setopt(curl, CURLOPT_URL, request.url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, write_header);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS,
                   static_cast<long>(request.timeout.count()));
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_USERAGENT, "eclipse-cli/2.0");

  if (request.method == "POST") {
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,
                     static_cast<long>(request.body.size()));
  } else if (request.method != "GET") {
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, request.method.c_str());
  }

  const CURLcode code = curl_easy_perform(curl);
  if (code != CURLE_OK) {
    response.error = curl_easy_strerror(code);
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status);
  }

  curl_slist_free_all(headers);
  return response;
}

HttpResponse HttpClient::post_json(const std::string& url,
                                   const std::string& body,
                                   std::chrono::milliseconds timeout) {
  HttpRequest request;
  request.url = url;
  request.method = "POST";
  request.body = body;
  request.timeout = timeout;
  return send(request);
}

HttpResponse HttpClient::get(const std::string& url,
                             std::chrono::milliseconds timeout) {
  HttpRequest request;
  request.url = url;
  request.method = "GET";
  request.timeout = timeout;
  return send(request);
}

HttpResponse HttpClient::post_multipart_png(
    const std::string& url, const std::string& field_name,
    const std::string& file_name, const std::vector<std::uint8_t>& bytes,
    const std::string& payload_json) {
  HttpResponse response;

  CURL* curl = thread_handle();
  if (curl == nullptr) {
    response.error = "could not initialise curl";
    return response;
  }
  curl_easy_reset(curl);

  curl_mime* mime = curl_mime_init(curl);

  curl_mimepart* file_part = curl_mime_addpart(mime);
  curl_mime_name(file_part, field_name.c_str());
  curl_mime_filename(file_part, file_name.c_str());
  curl_mime_type(file_part, "image/png");
  curl_mime_data(file_part, reinterpret_cast<const char*>(bytes.data()),
                 bytes.size());

  if (!payload_json.empty()) {
    curl_mimepart* json_part = curl_mime_addpart(mime);
    curl_mime_name(json_part, "payload_json");
    curl_mime_type(json_part, "application/json");
    curl_mime_data(json_part, payload_json.c_str(), payload_json.size());
  }

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 30000L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  const CURLcode code = curl_easy_perform(curl);
  if (code != CURLE_OK) {
    response.error = curl_easy_strerror(code);
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status);
  }

  curl_mime_free(mime);
  return response;
}

}  // namespace eclipse::net
