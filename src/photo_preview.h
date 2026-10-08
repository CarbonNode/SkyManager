#pragma once
#include "photo_studio_model.h"
#include <string>
namespace PhotoPreview {
// Main-thread publication; renderer owns all COM resources and context calls.
void Publish(bool visible, const PhotoFrame::Frame&, PhotoStudio::Bounds, float exposure);
void Render(); // called only from the existing pre-Prisma present hook
std::string Status();
bool Failed();
}
