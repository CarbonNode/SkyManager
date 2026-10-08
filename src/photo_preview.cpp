#include "photo_preview.h"
#include <d3d11_1.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <mutex>
#include <atomic>
#include <cstring>
#ifdef min
#undef min
#undef max
#endif

namespace PhotoPreview {
namespace {
using Microsoft::WRL::ComPtr;
struct Publication { bool visible=false; PhotoFrame::Frame frame; PhotoStudio::Bounds bounds; float exposure=0; std::uint64_t epoch=0; };
std::mutex mutex;
Publication publication;
std::string status="Off";
std::atomic_uint64_t failedEpoch=0;
// Only Render touches these COM objects. End/shutter publishes a flag, never
// releases a resource while the render thread may still be using it.
ComPtr<ID3D11Device> owner;
ComPtr<ID3D11DeviceContext1> context;
ComPtr<ID3DDeviceContextState> clean;
ComPtr<ID3D11Texture2D> texture;
ComPtr<ID3D11ShaderResourceView> image;
ComPtr<ID3D11VertexShader> vertex;
ComPtr<ID3D11PixelShader> pixel;
ComPtr<ID3D11SamplerState> sampler;
ComPtr<ID3D11Buffer> constants;
ComPtr<ID3D11RasterizerState> raster;
D3D11_TEXTURE2D_DESC allocated{};
constexpr const char* shader=R"(
cbuffer Tuning:register(b0) { float exposure; float linearSource; float2 pad; };
Texture2D shot:register(t0); SamplerState sampleShot:register(s0);
struct V {float4 p:SV_Position;float2 uv:TEXCOORD0;};
V vs(uint id:SV_VertexID) {
  V o; o.uv=float2((id<<1)&2,id&2);o.p=float4(o.uv*float2(2,-2)+float2(-1,1),0,1);return o;
}
float4 ps(V v):SV_Target {
  float3 c=shot.Sample(sampleShot,v.uv).rgb;
  if(abs(exposure)>0.001) {
    if(linearSource>0.5)c=saturate(c*exp2(exposure));
    else c=pow(saturate(pow(max(c,0),2.2)*exp2(exposure)),1.0/2.2);
  }
  return float4(c,1);
})";
void Reset() {
    image.Reset();texture.Reset();vertex.Reset();pixel.Reset();sampler.Reset();constants.Reset();raster.Reset();
    clean.Reset();context.Reset();owner.Reset();allocated={};
}
void Status(const char* value) {std::lock_guard lock(mutex);status=value;}
bool Init(ID3D11Device* device) {
    Reset();owner=device;
    ComPtr<ID3D11Device1> d;
    ComPtr<ID3D11DeviceContext> ctx;device->GetImmediateContext(&ctx);
    if(FAILED(device->QueryInterface(IID_PPV_ARGS(&d)))||!ctx||FAILED(ctx.As(&context)))return false;
    const D3D_FEATURE_LEVEL levels[]={D3D_FEATURE_LEVEL_11_1,D3D_FEATURE_LEVEL_11_0,D3D_FEATURE_LEVEL_10_1,D3D_FEATURE_LEVEL_10_0};
    D3D_FEATURE_LEVEL chosen{};
    // Full context-state swap restores every pipeline slot, including class
    // instances/UAVs not explicitly touched here. Refuse if this API is absent.
    if(FAILED(d->CreateDeviceContextState(0,levels,4,D3D11_SDK_VERSION,__uuidof(ID3D11Device),&chosen,&clean)))return false;
    ComPtr<ID3DBlob> vs,ps,errors;
    if(FAILED(D3DCompile(shader,std::strlen(shader),"SkyManagerPhotoPreview",nullptr,nullptr,"vs","vs_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&vs,&errors))||
       FAILED(D3DCompile(shader,std::strlen(shader),"SkyManagerPhotoPreview",nullptr,nullptr,"ps","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&ps,&errors)))return false;
    if(FAILED(device->CreateVertexShader(vs->GetBufferPointer(),vs->GetBufferSize(),nullptr,&vertex))||
       FAILED(device->CreatePixelShader(ps->GetBufferPointer(),ps->GetBufferSize(),nullptr,&pixel)))return false;
    D3D11_SAMPLER_DESC sd{};sd.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;sd.AddressU=sd.AddressV=sd.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;sd.MaxLOD=D3D11_FLOAT32_MAX;
    D3D11_BUFFER_DESC bd{};bd.ByteWidth=16;bd.Usage=D3D11_USAGE_DEFAULT;bd.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
    D3D11_RASTERIZER_DESC rd{};rd.FillMode=D3D11_FILL_SOLID;rd.CullMode=D3D11_CULL_NONE;rd.DepthClipEnable=TRUE;
    return SUCCEEDED(device->CreateSamplerState(&sd,&sampler))&&SUCCEEDED(device->CreateBuffer(&bd,nullptr,&constants))&&SUCCEEDED(device->CreateRasterizerState(&rd,&raster));
}
bool Supported(DXGI_FORMAT f) {
    return f==DXGI_FORMAT_R8G8B8A8_UNORM||f==DXGI_FORMAT_B8G8R8A8_UNORM||
        f==DXGI_FORMAT_R10G10B10A2_UNORM||f==DXGI_FORMAT_R16G16B16A16_FLOAT||f==DXGI_FORMAT_R11G11B10_FLOAT;
}
}
void Publish(bool visible,const PhotoFrame::Frame& frame,PhotoStudio::Bounds bounds,float exposure) {
    std::lock_guard lock(mutex);
    if(visible&&!publication.visible){++publication.epoch;status="Starting live preview…";}
    publication.visible=visible;publication.frame=frame;publication.bounds=bounds;publication.exposure=exposure;
    if(!visible)status="Off";
}
std::string Status(){std::lock_guard lock(mutex);return status;}
bool Failed(){std::lock_guard lock(mutex);return publication.visible&&failedEpoch.load()==publication.epoch;}
void Render() {
    Publication p;
    {std::lock_guard lock(mutex);p=publication;}
    if(!p.visible){if(owner)Reset();return;}
    if(p.epoch==failedEpoch||!p.frame.Valid()||!PhotoStudio::Valid(p.bounds))return;
    auto fail=[&](const char* reason){failedEpoch=p.epoch;Reset();Status(reason);logger::warn("photo-preview: disabled for this activation: {}",reason);};
    auto* device=reinterpret_cast<ID3D11Device*>(RE::BSGraphics::Renderer::GetDevice());
    auto* window=RE::BSGraphics::Renderer::GetCurrentRenderWindow();
    if(!device||!window||!window->swapChain){fail("Renderer unavailable. Turn preview off/on to retry.");return;}
    if(owner.Get()!=device&& !Init(device)){fail("Live preview unavailable on this D3D context. Photo mode still works.");return;}
    ComPtr<ID3D11Texture2D> back;
    auto* swap=reinterpret_cast<IDXGISwapChain*>(window->swapChain);
    if(FAILED(swap->GetBuffer(0,IID_PPV_ARGS(&back)))){fail("Backbuffer unavailable. Photo mode still works.");return;}
    D3D11_TEXTURE2D_DESC desc{};back->GetDesc(&desc);
    if(desc.Width!=static_cast<UINT>(p.frame.sourceWidth)||desc.Height!=static_cast<UINT>(p.frame.sourceHeight))return; // bounded main-thread refresh publishes new crop
    if(!Supported(desc.Format)||desc.SampleDesc.Count!=1){fail("Unsupported preview format. Photo mode still works.");return;}
    if(!texture||allocated.Width!=static_cast<UINT>(p.frame.width)||allocated.Height!=static_cast<UINT>(p.frame.height)||allocated.Format!=desc.Format) {
        image.Reset();texture.Reset();allocated=desc;allocated.Width=p.frame.width;allocated.Height=p.frame.height;
        allocated.MipLevels=1;allocated.ArraySize=1;allocated.Usage=D3D11_USAGE_DEFAULT;allocated.BindFlags=D3D11_BIND_SHADER_RESOURCE;allocated.CPUAccessFlags=0;allocated.MiscFlags=0;
        if(FAILED(device->CreateTexture2D(&allocated,nullptr,&texture))||FAILED(device->CreateShaderResourceView(texture.Get(),nullptr,&image))) {fail("Preview texture could not be created. Photo mode still works.");return;}
    }
    ComPtr<ID3D11RenderTargetView> output;
    if(FAILED(device->CreateRenderTargetView(back.Get(),nullptr,&output))){fail("Preview target unavailable. Photo mode still works.");return;}
    // Crop copy precedes any of OUR drawing and the downstream Prisma draw.
    // Screenshot readback also runs BEFORE Render, so the preview cannot enter
    // a saved photo. No CPU Map, PNG, second scene render or global driver lock.
    const D3D11_BOX crop={static_cast<UINT>(p.frame.x),static_cast<UINT>(p.frame.y),0,static_cast<UINT>(p.frame.x+p.frame.width),static_cast<UINT>(p.frame.y+p.frame.height),1};
    ComPtr<ID3DDeviceContextState> previous;
    context->SwapDeviceContextState(clean.Get(),&previous);
    context->CopySubresourceRegion(texture.Get(),0,0,0,0,back.Get(),0,&crop);
    float values[4]={p.exposure,desc.Format==DXGI_FORMAT_R16G16B16A16_FLOAT||desc.Format==DXGI_FORMAT_R11G11B10_FLOAT?1.f:0.f,0,0};
    context->UpdateSubresource(constants.Get(),0,nullptr,values,0,0);
    const auto screen=RE::BSGraphics::Renderer::GetScreenSize();
    const auto box=PhotoStudio::Fit(p.bounds,screen.width,screen.height,p.frame.width,p.frame.height);
    D3D11_VIEWPORT viewport={box.x*desc.Width,box.y*desc.Height,box.w*desc.Width,box.h*desc.Height,0,1};
    auto* rtv=output.Get();auto* srv=image.Get();auto* samp=sampler.Get();auto* cb=constants.Get();
    context->OMSetRenderTargets(1,&rtv,nullptr);context->OMSetBlendState(nullptr,nullptr,0xffffffff);
    context->OMSetDepthStencilState(nullptr,0);context->RSSetState(raster.Get());context->RSSetViewports(1,&viewport);
    context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertex.Get(),nullptr,0);context->PSSetShader(pixel.Get(),nullptr,0);
    context->GSSetShader(nullptr,nullptr,0);context->HSSetShader(nullptr,nullptr,0);context->DSSetShader(nullptr,nullptr,0);
    context->PSSetShaderResources(0,1,&srv);context->PSSetSamplers(0,1,&samp);context->PSSetConstantBuffers(0,1,&cb);
    context->Draw(3,0);
    // The reusable clean state must not retain a swapchain buffer across resize.
    ID3D11ShaderResourceView* empty=nullptr;
    context->PSSetShaderResources(0,1,&empty);
    context->OMSetRenderTargets(0,nullptr,nullptr);
    context->SwapDeviceContextState(previous.Get(),nullptr);
    Status("Live GPU preview");
}
}
