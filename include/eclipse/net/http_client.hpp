#pragma once

#include <chrono>
#include <map>
#include <string>
#include <vector>

namespace eclipse::net {

struct HttpResponse {
  long status = 0;
  std::string body;
  std::map<std::string, std::string> headers;
  std::string error;  ///< transport-level failure; empty on success

  bool ok() const { return error.empty() && status >= 200 && status < 300; }
  bool rate_limited() const { return status == 429; }
};

struct HttpRequest {
  std::string url;
  std::string method = "POST";
  std::string body;
  std::vector<std::string> headers{"Content-Type: application/json"};
  std::chrono::milliseconds timeout{30000};
};

/// Thin libcurl wrapper. One handle per thread, reused across calls so
/// connections stay warm; the RPC path is hot enough for that to matter.
class HttpClient {
 public:
  static HttpClient& instance();

  HttpResponse send(const HttpRequest& request);

  HttpResponse post_json(const std::string& url, const std::string& body,
                         std::chrono::milliseconds timeout =
                             std::chrono::milliseconds(30000));

  HttpResponse get(const std::string& url,
                   std::chrono::milliseconds timeout =
                       std::chrono::milliseconds(15000));

  /// Multipart upload, used for the Discord position card.
  HttpResponse post_multipart_png(const std::string& url,
                                  const std::string& field_name,
                                  const std::string& file_name,
                                  const std::vector<std::uint8_t>& bytes,
                                  const std::string& payload_json);

  HttpClient(const HttpClient&) = delete;
  HttpClient& operator=(const HttpClient&) = delete;

 private:
  HttpClient();
  ~HttpClient();
};

}  // namespace eclipse::net
